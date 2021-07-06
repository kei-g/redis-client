import { Socket } from 'net'

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
      switch (typeof arg) {
        case 'bigint':
        case 'number':
          const length = `${arg}`.length
          return `$${length}\r\n${arg}\r\n`
        case 'boolean':
          return `$1\r\n${arg ? 1 : 0}\r\n`
        case 'string':
          const u8 = Buffer.from(arg)
          return `$${u8.byteLength}\r\n${arg}\r\n`
        case 'undefined':
          return '$-1\r\n'
      }
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

  flushall(): Promise<Error | string> {
    return this.push('FLUSHALL')
  }

  get(key: string): Promise<Error | number | string> {
    return this.push('GET', key)
  }

  hget<T>(key: string, field: string): Promise<Error | T> {
    return this.push('HGET', key, field)
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

  incr(key: string): Promise<number> {
    return this.push('INCR', key)
  }

  incrBy(key: string, count: number): Promise<number> {
    return this.push('INCRBY', key, count)
  }

  multi(): Promise<boolean> {
    return this.push('MULTI', (reply: Error | string) => !(reply instanceof Error) && typeof reply === 'string' && reply === 'OK')
  }

  on(event: 'closed' | 'connected' | 'error', listener: (() => void) | ((error: Error) => void)): void {
    if (!listener)
      throw new Error(`invalid argument for ${event}, ${listener}`)
    this.listeners[event].push(listener as unknown as (() => void))
  }

  sadd(key: string, member: number | string): Promise<Error | number> {
    return this.push('SADD', key, member)
  }

  set(key: string, value: number | string): Promise<Error | string> {
    return this.push('SET', key, value)
  }

  smembers<T>(key: string): Promise<T[]> {
    return this.push('SMEMBERS', key)
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

  rpush(key: string, value: number | string): Promise<boolean> {
    return this.push('RPUSH', key, value, (reply: Error | number) => !(reply instanceof Error) && reply)
  }

  unwatch(): Promise<Error | string> {
    return this.push('UNWATCH')
  }

  watch(...keys: string[]): Promise<Error | string> {
    return this.push('WATCH', ...keys)
  }

  zadd(key: string, score: number, member: number | string): Promise<Error | number> {
    return this.push('ZADD', key, score, member)
  }

  zcard(key: string): Promise<Error | number> {
    return this.push('ZCARD', key)
  }

  zrange<T>(key: string, start?: number, end?: number): Promise<Error | T[]> {
    return this.push('ZRANGE', key, start ?? 0, end ?? -1)
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
      if (/^[\+\-]?[0-9]+$/.test(dataString))
        return Number.parseInt(dataString, 10)
      if (/^[\+\-]?[0-9]*\.[0-9]+$/.test(dataString))
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
