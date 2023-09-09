import { RedisClient } from '../src'
import { describe, it } from 'mocha'
import { expect } from 'chai'

type Foo = {
  value: string
}

const db = new RedisClient()
db.on('connected', async () => {
  await db.del('foo-stream')
  describe('stream - single', () => {
    it('add', async () => {
      const id = await db.xadd('foo-stream', 'foo')
      expect(typeof id).equal('string')
    })
    it('len', async () => {
      const len = await db.xlen('foo-stream')
      expect(typeof len).equal('number')
      expect(len).equal(1)
    })
    it('range', async () => {
      const res = await db.xrange<Foo>('foo-stream')
      expect(typeof res).equal('object')
      if (!(res instanceof Error))
        for (const id in res) {
          if (res[id] instanceof Error)
            continue
          expect(res[id].value).equal('foo')
        }
    })
    it('reverse range', async () => {
      const res = await db.xrevrange<Foo>('foo-stream')
      expect(typeof res).equal('object')
      if (!(res instanceof Error))
        for (const id in res) {
          if (res[id] instanceof Error)
            continue
          expect(res[id].value).equal('foo')
        }
    })
  })
  await db.del('bar-stream')
  await db.del('foo-stream')
  describe('stream - multiple', () => {
    it('add', async () => {
      const first = await db.xadd('bar-stream', 'fizz')
      expect(typeof first).equal('string')
      const second = await db.xadd('bar-stream', 'buzz')
      expect(typeof second).equal('string')
    })
    it('len', async () => {
      const len = await db.xlen('bar-stream')
      expect(typeof len).equal('number')
      expect(len).equal(2)
    })
    it('range', async () => {
      const res = await db.xrange<Foo>('bar-stream')
      expect(typeof res).equal('object')
      if (!(res instanceof Error))
        for (const id in res)
          expect(res[id]).not.instanceof(Error)
    })
    it('reverse range', async () => {
      const res = await db.xrevrange<Foo>('bar-stream')
      expect(typeof res).equal('object')
      if (!(res instanceof Error))
        for (const id in res)
          expect(res[id]).not.instanceof(Error)
    })
  })
  await db.del('bar-stream')
})
