/* eslint-disable no-unused-vars */

import { Socket } from 'net'

/**
 * コマンド組み立て関数の型
 */
type CommandComposer = (arg: unknown) => string

/**
 * Redisクライアント
 */
export class RedisClient {
  /**
   * 文字コード
   */
  private readonly charset: BufferEncoding

  /**
   * イベントリスナー
   */
  private readonly listeners: RedisClientEventListeners = {
    closed: [],
    connected: [],
    error: [],
  }

  /**
   * コマンドキュー
   */
  private readonly queue: RedisRequestQueue = {
    ready: [],
    sent: [],
  }

  /**
   * ソケット
   */
  private readonly socket: Socket

  /**
   * 状態
   */
  private readonly status: RedisClientStatus = {}

  /**
   * 冗長度
   */
  readonly verbosity?: RedisClientVerbosity

  /**
   * コンストラクタ
   * @param params 初期化子
   */
  constructor(params?: RedisClientCreateParameters) {
    this.charset = params?.charset ?? 'utf-8'
    this.socket = new Socket({ writable: true })
    if (params?.verbosity)
      this.verbosity = params.verbosity
    this.socket.on('close', (hadError: boolean) => this.onClose(hadError))
    this.socket.on('connect', () => this.onConnected())
    this.socket.on('data', (data: Buffer) => this.onData(data))
    this.socket.on('error', (error: Error) => this.onError(error))
    this.socket.on('timeout', () => this.onTimeout())
    this.socket.connect({
      host: params?.host ?? '127.0.0.1',
      port: params?.port ?? 6379,
    })
  }

  /**
   * コマンドを組み立てる
   * @param command コマンド
   * @param args 引数の配列
   * @returns コマンド
   */
  private compose(command: string, ...args: any[]): string {
    const bulks = args?.filter((arg: any) => !['function', 'object', 'symbol'].includes(typeof arg))?.map((arg: any) => {
      const composer = commandComposers[typeof arg] as unknown as CommandComposer
      return composer && composer(arg)
    }) ?? []
    return `*${bulks.length + 1}\r\n$${command.length}\r\n${command}\r\n${bulks.join('')}`
  }

  /**
   * ソケットの切断処理
   * @param hadError エラーが発生したかどうか
   */
  private onClose(hadError: boolean): void {
    delete this.status.connected
    if (this.verbosity === 'verbose')
      console.debug(`closed with${hadError ? 'out' : ''} error`)
    while (this.queue.sent.length) {
      const req = this.queue.sent.shift()
      if (req)
        setImmediate(() => req.reject())
    }
    while (this.queue.ready.length) {
      const req = this.queue.ready.shift()
      if (req)
        setImmediate(() => req.reject())
    }
  }

  /**
   * ソケットの接続処理
   */
  private onConnected(): void {
    if (this.verbosity === 'verbose')
      console.debug('connected')
    this.status.connected = true
    for (const listener of this.listeners.connected)
      listener()
    setImmediate(() => this.onIdle())
  }

  /**
   * ソケットのデータ受信処理
   * @param data 受信データ
   */
  private onData(data: Buffer): void {
    if (this.status.reply)
      this.status.reply = Buffer.concat([new Uint8Array(this.status.reply), new Uint8Array(data)])
    else
      this.status.reply = data
    setImmediate(() => this.onIdle())
  }

  /**
   * ソケットのエラー処理
   * @param error エラー
   */
  private onError(error: Error): void {
    for (const listener of this.listeners.error)
      listener(error)
  }

  /**
   * アイドル処理
   */
  private onIdle(): void {
    // client to server
    if (this.queue.ready.length && this.status.connected) {
      const req = this.queue.ready.shift()
      if (req) {
        if (this.verbosity === 'verbose')
          console.debug(req.requestString)
        this.queue.sent.push(req)
        if (!req.send(this.socket))
          this.queue.sent.pop()
      }
    }

    // server to client
    if (this.queue.sent.length && this.status.reply)
      try {
        const data = this.status.reply
        if (this.verbosity === 'verbose')
          console.debug(data.toString())
        const context: RedisReplyContext = {
          charset: this.charset,
          data,
          offset: 0
        }
        const reply = parseReplyLine(context)
        if (context.offset < this.status.reply.byteLength)
          this.status.reply = this.status.reply.slice(context.offset)
        else
          delete this.status.reply
        try {
          const req = this.queue.sent.shift()
          if (req)
            setImmediate(() => req.reply(reply))
          else
            this.onError(new Error(`reply overflown ${reply}`))
        }
        catch (error: any) {
          this.onError(error)
        }
      }
      catch (error: any) {
        this.onError(error)
      }

    // retry if necessary
    if ((this.queue.ready.length && this.status.connected) || this.queue.sent.length)
      setImmediate(() => this.onIdle())
  }

  /**
   * ソケットのタイムアウト処理
   */
  private onTimeout(): void {
  }

  /**
   * コマンドをキューに追加する
   * @param command コマンド
   * @param args 引数の配列
   * @returns 実行結果へのPromise
   */
  private push<T>(command: string, ...args: any[]): Promise<T> {
    const requestString = this.compose(command, ...args)
    return new Promise<T>((resolve: (value: T) => void, reject: (reason?: any) => void) => {
      const req = new RedisRequest<T>(this, requestString, resolve, reject, ...args)
      this.queue.ready.push(req)
      setImmediate(() => this.onIdle())
    })
  }

  append(key: string, value: string): Promise<number> {
    return this.push('APPEND', key, value)
  }

  copy(source: string, destination: string): Promise<boolean> {
    return this.push('COPY', source, destination, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  get dbsize(): Promise<number> {
    return this.push('DBSIZE')
  }

  decr(key: string): Promise<boolean> {
    return this.push('DECR', key, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  decrBy(key: string, decrement: number): Promise<Error | number> {
    return this.push('DECRBY', key, decrement)
  }

  del(key: string): Promise<boolean> {
    return this.push('DEL', key, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  discard(): Promise<Error | string> {
    return this.push('DISCARD')
  }

  eval<T>(script: string, numberOfKeys: number, ...keysAndArgs: string[]): Promise<Error | T> {
    return this.push('EVAL', script, numberOfKeys, ...keysAndArgs)
  }

  exec(): Promise<RedisReply> {
    return this.push('EXEC')
  }

  exists(key: string): Promise<boolean> {
    return this.push('EXISTS', key, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  expire(key: string, ttl: number): Promise<boolean> {
    return this.push('EXPIRE', key, ttl, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  expireAt(key: string, timestamp: number): Promise<boolean> {
    return this.push('EXPIREAT', key, timestamp, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  flushall(): Promise<Error | string> {
    return this.push('FLUSHALL')
  }

  get(key: string): Promise<Error | number | string> {
    return this.push('GET', key)
  }

  hget<T>(key: string, field: string): Promise<Error | T> {
    return this.push('HGET', key, field)
  }

  hdel(key: string, field: string): Promise<boolean> {
    return this.push('HDEL', key, field, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  hexists(key: string, field: string): Promise<boolean> {
    return this.push('HEXISTS', key, field, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  async hgetall(key: string): Promise<Record<string, RedisPrimitiveReply>> {
    const fieldsAndValues = await this.push<RedisPrimitiveReply[]>('HGETALL', key)
    const result: Record<string, RedisPrimitiveReply> = {}
    for (let i = 0; i < fieldsAndValues.length; i += 2) {
      const prop = fieldsAndValues[i]
      if (prop instanceof Error)
        continue
      result[prop] = fieldsAndValues[i + 1]
    }
    return result
  }

  hincrby(key: string, field: string, increment: number): Promise<Error | number> {
    return this.push('HINCRBY', key, field, increment)
  }

  hkeys(key: string): Promise<string[]> {
    return this.push('HKEYS', key)
  }

  hlen(key: string): Promise<number> {
    return this.push('HLEN', key)
  }

  hmget(key: string, ...fields: string[]): Promise<RedisPrimitiveReply[]> {
    return this.push('HMGET', key, ...fields)
  }

  hmset(key: string, ...fieldAndValues: (number | string)[]): Promise<Error | string> {
    return this.push('HMSET', key, ...fieldAndValues)
  }

  hset(key: string, field: string, value: number | string): Promise<boolean> {
    return this.push('HSET', key, field, value, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  hsetnx(key: string, field: string, value: number | string): Promise<boolean> {
    return this.push('HSETNX', key, field, value, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  hstrlen(key: string, field: string): Promise<number> {
    return this.push('HSTRLEN', key, field)
  }

  incr(key: string): Promise<number> {
    return this.push('INCR', key)
  }

  incrBy(key: string, count: number): Promise<number> {
    return this.push('INCRBY', key, count)
  }

  keys(pattern: string): Promise<string[]> {
    return this.push('KEYS', pattern)
  }

  lindex(key: string, index: number): Promise<RedisPrimitiveReply> {
    return this.push('LINDEX', key, index)
  }

  llen(key: string): Promise<number> {
    return this.push('LLEN', key)
  }

  lpop(key: string): Promise<RedisPrimitiveReply> {
    return this.push('LPOP', key)
  }

  lpush(key: string, element: string | number): Promise<Error | number> {
    return this.push('LPUSH', key, element)
  }

  lpushx(key: string, element: string | number): Promise<boolean> {
    return this.push('LPUSHX', key, element, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  lrange(key: string, start: number, stop: number): Promise<RedisPrimitiveReply[]> {
    return this.push('LRANGE', key, start, stop)
  }

  lset(key: string, index: number, element: string | number): Promise<Error | string> {
    return this.push('LSET', key, index, element)
  }

  mget(...keys: string[]): Promise<RedisPrimitiveReply[]> {
    return this.push('MGET', ...keys)
  }

  mset(...keysAndValues: (string | number)[]): Promise<Error | string> {
    return this.push('MSET', ...keysAndValues)
  }

  msetnx(...keysAndValues: (string | number)[]): Promise<boolean> {
    return this.push('MSETNX', ...keysAndValues, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  multi(): Promise<boolean> {
    return this.push('MULTI', (reply: Error | string) => !(reply instanceof Error) && typeof reply === 'string' && reply === 'OK')
  }

  on(event: 'closed' | 'connected' | 'error', listener: (() => void) | ((error: Error) => void)): void {
    if (!listener)
      throw new Error(`invalid argument for ${event}, ${listener}`)
    this.listeners[event].push(listener as unknown as (() => void))
  }

  persist(key: string): Promise<boolean> {
    return this.push('PERSIST', key, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  get randomKey(): Promise<string> {
    return this.push('RANDOMKEY')
  }

  rename(key: string, newKey: string): Promise<Error | string> {
    return this.push('RENAME', key, newKey)
  }

  renamenx(key: string, newKey: string): Promise<boolean> {
    return this.push('RENAMENX', key, newKey, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  rpop(key: string): Promise<RedisPrimitiveReply> {
    return this.push('RPOP', key)
  }

  rpoplpush(source: string, destination: string): Promise<Error | string> {
    return this.push('RPOPLPUSH', source, destination)
  }

  rpush(key: string, element: number | string): Promise<boolean> {
    return this.push('RPUSH', key, element, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  rpushx(key: string, element: number | string): Promise<boolean> {
    return this.push('RPUSHX', key, element, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  sadd(key: string, member: number | string): Promise<Error | number> {
    return this.push('SADD', key, member)
  }

  scard(key: string): Promise<Error | number> {
    return this.push('SCARD', key)
  }

  set(key: string, value: number | string): Promise<Error | string> {
    return this.push('SET', key, value)
  }

  setex(key: string, seconds: number, value: string | number): Promise<Error | string> {
    return this.push('SETEX', key, seconds, value)
  }

  setnx(key: string, value: string | number): Promise<boolean> {
    return this.push('SETNX', key, value, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  sismember(key: string, member: string | number): Promise<boolean> {
    return this.push('SISMEMBER', key, member, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  smembers<T>(key: string): Promise<T[]> {
    return this.push('SMEMBERS', key)
  }

  spop(key: string): Promise<RedisPrimitiveReply> {
    return this.push('SPOP', key)
  }

  srandmember(key: string): Promise<RedisPrimitiveReply> {
    return this.push('SRANDMEMBER', key)
  }

  srem(key: string, member: number | string): Promise<boolean> {
    return this.push('SREM', key, member, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  strlen(key: string): Promise<number> {
    return this.push('STRLEN', key)
  }

  ttl(key: string): Promise<Error | number> {
    return this.push('TTL', key)
  }

  type(key: string): Promise<string> {
    return this.push('TYPE', key)
  }

  unwatch(): Promise<Error | string> {
    return this.push('UNWATCH')
  }

  watch(...keys: string[]): Promise<Error | string> {
    return this.push('WATCH', ...keys)
  }

  xadd(key: string, value: Record<string | symbol, bigint | number | string> | bigint | number | string): Promise<Error | string> {
    switch (typeof value) {
      case 'bigint':
      case 'number':
      case 'string':
        return this.push('XADD', key, '*', 'value', value)
      case 'object':
        const args = [] as unknown[]
        for (const key in value) {
          args.push(key)
          args.push(value[key])
        }
        return this.push('XADD', key, '*', ...args)
    }
  }

  xlen(key: string): Promise<Error | number> {
    return this.push('XLEN', key)
  }

  async xrange<T>(key: string, count?: number): Promise<Error | Record<string, T>> {
    const fieldsAndValues = count === undefined ? await this.push<RedisPrimitiveReply[]>('XRANGE', key, '-', '+') : await this.push<RedisPrimitiveReply[]>('XRANGE', key, '-', '+', 'COUNT', count)
    const result = {} as Record<string, T>
    const ctx = { last: undefined as T }
    for (let i = 0; i < fieldsAndValues.length; i++) {
      const fv = fieldsAndValues[i]
      if (typeof fv === 'string')
        if (fv.match(/^\d+-\d$/))
          result[fv] = ctx.last = {} as T
        else
          (ctx.last as unknown as Record<string, unknown>)[fv] = fieldsAndValues[++i]
    }
    return result
  }

  async xrevrange<T>(key: string, count?: number): Promise<Error | Record<string, T>> {
    const fieldsAndValues = count === undefined ? await this.push<RedisPrimitiveReply[]>('XREVRANGE', key, '+', '-') : await this.push<RedisPrimitiveReply[]>('XREVRANGE', key, '+', '-', 'COUNT', count)
    const result = {} as Record<string, T>
    const ctx = { last: undefined as T }
    for (let i = 0; i < fieldsAndValues.length; i++) {
      const fv = fieldsAndValues[i]
      if (typeof fv === 'string')
        if (fv.match(/^\d+-\d$/))
          result[fv] = ctx.last = {} as T
        else
          (ctx.last as unknown as Record<string, unknown>)[fv] = fieldsAndValues[++i]
    }
    return result
  }

  zadd(key: string, score: number, member: number | string): Promise<Error | number> {
    return this.push('ZADD', key, score, member)
  }

  zcard(key: string): Promise<Error | number> {
    return this.push('ZCARD', key)
  }

  zcount(key: string, min: number | string, max: number | string): Promise<Error | number> {
    return this.push('ZCOUNT', key, min, max)
  }

  zincrby(key: string, increment: number, member: string | number): Promise<Error | string> {
    return this.push('ZINCRBY', key, increment, member)
  }

  zpopmax(key: string): Promise<RedisPrimitiveReply> {
    return this.push('ZPOPMAX', key)
  }

  zpopmin(key: string): Promise<RedisPrimitiveReply> {
    return this.push('ZPOPMIN', key)
  }

  zrange<T>(key: string, start?: number, end?: number): Promise<Error | T[]> {
    return this.push('ZRANGE', key, start ?? 0, end ?? -1)
  }

  zrank(key: string, member: string | number): Promise<Error | number> {
    return this.push('ZRANK', key, member)
  }

  zrem(key: string, member: number | string): Promise<Error | number> {
    return this.push('ZREM', key, member)
  }
}

/**
 * Redisクライアント初期化子
 */
export type RedisClientCreateParameters = {
  /**
   * 文字コード
   */
  charset?: BufferEncoding

  /**
   * 接続先ホスト
   */
  host?: string

  /**
   * 接続先ポート番号
   */
  port?: number

  /**
   * 冗長度
   */
  verbosity?: RedisClientVerbosity
}

/**
 * イベントリスナー
 */
type RedisClientEventListeners = {
  /**
   * 切断
   */
  closed: (() => void)[]

  /**
   * 接続完了
   */
  connected: (() => void)[]

  /**
   * エラー発生
   */
  error: ((error: Error) => void)[]
}

/**
 * クライアントの状態
 */
type RedisClientStatus = {
  /**
   * 接続済み
   */
  connected?: true

  /**
   * 返信データ
   */
  reply?: Buffer
}

/**
 * 冗長度
 */
export type RedisClientVerbosity = 'quiet' | 'verbose'

type RedisPrimitiveReply = string | number | Error

type RedisReply = RedisPrimitiveReply | RedisPrimitiveReply[] | null

type RedisReplyContext = {
  charset: BufferEncoding
  data: Buffer
  offset: number
}

class RedisRequest<T> {
  /**
   * 要求データ
   */
  private readonly requestData: Buffer

  /**
   * 受信データから結果型へのセレクタ
   */
  private readonly selector: ((value: any) => T)

  /**
   *
   * @param client クライアント
   * @param requestString 要求データ
   * @param resolve 成功コールバック
   * @param reject 失敗コールバック
   * @param args 引数の配列
   */
  constructor(private readonly client: RedisClient, readonly requestString: string, private readonly resolve: (value: T) => void, readonly reject: (reason?: any) => void, ...args: any[]) {
    this.requestData = Buffer.from(requestString)
    this.selector = args?.find((arg: any) => typeof arg === 'function') ?? ((value: any) => value as T)
  }

  /**
   * 受信データを結果型に変換してコールバックを実行する
   * @param value 受信した値
   */
  reply(value: any): void {
    try {
      const result = this.selector(value)
      this.resolve(result)
    }
    catch (error: unknown) {
      this.reject(error)
    }
  }

  /**
   * 要求データを送信する
   * @param socket ソケット
   * @returns 成否
   */
  send(socket: Socket): boolean {
    return socket.write(this.requestData, (error?: Error) => {
      if (error) {
        if (this.client.verbosity !== 'quiet')
          console.error(error)
        this.reject(error)
      }
    })
  }
}

/**
 * リクエストキュー
 */
type RedisRequestQueue = {
  /**
   * 送信準備完了
   */
  ready: RedisRequest<any>[]

  /**
   * 送信済み
   */
  sent: RedisRequest<any>[]
}

/**
 * Booleanのコマンドを組み立てる
 */
const composeBoolean = (arg: boolean) => `$1\r\n${arg ? 1 : 0}\r\n`

/**
 * 数値のコマンドを組み立てる
 */
const composeNumber = (arg: bigint | number) => {
  const text = arg.toString()
  return `$${text.length}\r\n${text}\r\n`
}

/**
 * 文字列のコマンドを組み立てる
 */
const composeString = (arg: string) => {
  const u8 = Buffer.from(arg)
  return `$${u8.byteLength}\r\n${arg}\r\n`
}

/**
 * undefinedのコマンドを組み立てる
 */
const composeUndefined = () => '$-1\r\n'

/**
 * コマンド組み立て関数の連想配列
 */
const commandComposers = {
  bigint: composeNumber,
  boolean: composeBoolean,
  function: () => '',
  number: composeNumber,
  object: () => '',
  string: composeString,
  symbol: composeString,
  undefined: composeUndefined,
}

/**
 * 返信行を解析する
 * @param context コンテキスト
 * @returns 解析結果
 */
function parseReplyLine(context: RedisReplyContext): RedisReply {
  if (context.data.length <= context.offset)
    throw new Error('out of range')
  const type = context.data.toString(context.charset, context.offset, context.offset + 1)
  context.offset++
  switch (type) {
    case '+':
      return readLine(context)
    case '-':
      return new Error(readLine(context))
    case ':':
      return Number.parseInt(readLine(context))
    case '$':
      const length = Number.parseInt(readLine(context))
      if (length < 0)
        return null
      if (context.data.length <= context.offset + length)
        throw new Error('out of range')
      const data = context.data.slice(context.offset, context.offset + length)
      context.offset += length + 2
      const dataString = data.toString(context.charset)
      if (/^[\\+\\-]?[0-9]+$/.test(dataString))
        return Number.parseInt(dataString, 10)
      if (/^[\\+\\-]?[0-9]*\.[0-9]+$/.test(dataString))
        return Number.parseFloat(dataString)
      return dataString
    case '*':
      const num = Number.parseInt(readLine(context))
      if (num < 0)
        return null
      const multibulkreply: RedisPrimitiveReply[] = []
      for (let i = 0; i < num; i++) {
        const reply = parseReplyLine(context)
        if (reply === null)
          continue
        else if (reply instanceof Array)
          multibulkreply.push(...reply)
        else
          multibulkreply.push(reply)
      }
      return multibulkreply
    default:
      throw new Error(`unknown reply type, ${type}`)
  }
}

/**
 * コンテキストから1行文の文字列を読み取る
 * @param context コンテキスト
 * @returns 読み取った1行に含まれる文字列
 */
function readLine(context: RedisReplyContext): string {
  const characters: string[] = []
  while (context.offset < context.data.byteLength) {
    const c = context.data.toString(context.charset, context.offset, context.offset + 1)
    context.offset++
    if (c === '\r') {
      if (context.offset < context.data.byteLength) {
        const lf = context.data.toString(context.charset, context.offset, context.offset + 1)
        context.offset++
        if (lf === '\n')
          break
        else
          throw new Error(`illegal character, ${lf}`)
      }
      throw new Error('out of range after \\r')
    }
    characters.push(c)
  }
  return characters.join('')
}
