import { RedisClient } from '../src'
import { describe, it } from 'mocha'
import { equal } from 'node:assert'

const db = new RedisClient()
db.on('connected', () =>
  describe('set and get', async function () {
    it('set foo PI returns OK', async function () {
      const reply = await db.set('foo', Math.PI)
      equal(typeof reply, 'string')
      equal(reply, 'OK')
    })
    it('get foo returns PI', async function () {
      const foo = await db.get('foo')
      equal(typeof foo, 'number')
      equal(foo, Math.PI)
    })
    it('del foo returns 1', async function () {
      const reply = await db.del('foo')
      equal(typeof reply, 'number')
      equal(reply, 1)
    })
  })
)
