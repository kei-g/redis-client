import assert, { equal } from 'node:assert'
import { RedisClient } from '../src'
import { describe, it } from 'mocha'

type Foo = {
  value: string
}

const db = new RedisClient()
db.on('connected', async () => {
  await db.del('foo-stream')
  describe('stream - single', () => {
    it('add', async () => {
      const id = await db.xadd('foo-stream', 'foo')
      equal(typeof id, 'string')
    })
    it('len', async () => {
      const len = await db.xlen('foo-stream')
      equal(typeof len, 'number')
      equal(len, 1)
    })
    it('range', async () => {
      const res = await db.xrange<Foo>('foo-stream')
      equal(typeof res, 'object')
      if (!(res instanceof Error))
        for (const id in res) {
          if (res[id] instanceof Error)
            continue
          equal(res[id].value, 'foo')
        }
    })
    it('reverse range', async () => {
      const res = await db.xrevrange<Foo>('foo-stream')
      equal(typeof res, 'object')
      if (!(res instanceof Error))
        for (const id in res) {
          if (res[id] instanceof Error)
            continue
          equal(res[id].value, 'foo')
        }
    })
  })
  await db.del('bar-stream')
  await db.del('foo-stream')
  describe('stream - multiple', () => {
    it('add', async () => {
      const first = await db.xadd('bar-stream', 'fizz')
      equal(typeof first, 'string')
      const second = await db.xadd('bar-stream', 'buzz')
      equal(typeof second, 'string')
    })
    it('len', async () => {
      const len = await db.xlen('bar-stream')
      equal(typeof len, 'number')
      equal(len, 2)
    })
    it('range', async () => {
      const res = await db.xrange<Foo>('bar-stream')
      equal(typeof res, 'object')
      if (!(res instanceof Error))
        for (const id in res)
          assert(!(res[id] instanceof Error))
    })
    it('reverse range', async () => {
      const res = await db.xrevrange<Foo>('bar-stream')
      equal(typeof res, 'object')
      if (!(res instanceof Error))
        for (const id in res)
          assert(!(res[id] instanceof Error))
    })
  })
  await db.del('bar-stream')
})
