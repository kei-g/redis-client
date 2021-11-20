import { RedisClient } from '../src'
import { describe, it } from 'mocha'
import { expect } from 'chai'

const db = new RedisClient()
db.on('connected', () =>
  describe('set and get', async function () {
    it('set foo PI returns OK', async function () {
      const reply = await db.set('foo', Math.PI)
      expect(reply).to.be.a('string')
      expect(reply).to.be.equal('OK')
    })
    it('get foo returns PI', async function () {
      const foo = await db.get('foo')
      expect(foo).to.be.a('number')
      expect(foo).to.be.equal(Math.PI)
    })
    it('del foo returns 1', async function () {
      const reply = await db.del('foo')
      expect(reply).to.be.a('number')
      expect(reply).to.be.equal(1)
    })
  })
)
