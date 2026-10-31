// Shared setup for the OC-CAT-1 hall agreement tests: a parish, an admin,
// a staff login, a room, and a held booking with one expected amount.
import request from 'supertest'
import { expect } from 'vitest'
import { RUN_ID } from './harness.js'
import { createOrg } from './provision.js'

const PW = 'cat133-r3-test-pw'
let ipSeq = 1
export const auth = t => ({ Authorization: `Bearer ${t}` })

export function makeHallFixtures(tag, ipBlock) {
  const nextIp = () => `10.${ipBlock}.${(ipSeq >> 8) & 255}.${(ipSeq++) & 255 || 1}`
  async function signup(name) {
    const email = `${tag}_${name}_${RUN_ID}@example.com`
    const r = await createOrg(this.server, {
      organizationName: `${tag} ${name} ${RUN_ID}`, name: `Admin ${name}`, email, password: PW,
    }, nextIp())
    expect(r.status).toBe(201)
    return { id: r.body.user.organization.id, token: r.body.token }
  }
  async function addUser(org, role, name) {
    const email = `${tag}_${name}_${RUN_ID}@example.com`
    const c = await request(this.server).post('/api/users').set(auth(org.token)).set('X-Forwarded-For', nextIp())
      .send({ name, email, password: PW, role })
    expect(c.status).toBe(201)
    const l = await request(this.server).post('/api/auth/login').set('X-Forwarded-For', nextIp()).send({ email, password: PW })
    expect(l.status).toBe(200)
    return { token: l.body.token, id: l.body.user.id }
  }
  async function room(org) {
    const r = await request(this.server).post('/api/catering/spaces').set(auth(org.token))
      .send({ name: 'Fellowship Hall', space_kind: 'fellowship_hall' })
    expect(r.status).toBe(201)
    return r.body.space
  }
  // A held booking with one saved line and a prepared draft agreement.
  async function preparedBooking(org, roomId, host, dayIso) {
    const made = await request(this.server).post('/api/catering/bookings').set(auth(org.token)).send({
      space_id: roomId, event_kind: 'hall_rental', host_name: host,
      starts_at: `${dayIso}T15:00:00.000Z`, ends_at: `${dayIso}T16:00:00.000Z`,
    })
    expect(made.status).toBe(201)
    const lines = await request(this.server).put(`/api/catering/bookings/${made.body.id}/milestones`).set(auth(org.token))
      .send({ milestones: [{ kind: 'hall_rental', amount: '5.00', due_on: '2026-12-01' }] })
    expect(lines.status).toBe(200)
    const prep = await request(this.server).post(`/api/catering/bookings/${made.body.id}/agreement`).set(auth(org.token))
    expect(prep.status).toBe(201)
    return { bookingId: made.body.id, prep: prep.body }
  }
  return { signup, addUser, room, preparedBooking }
}

export const tokenOf = copyPath => decodeURIComponent(String(copyPath).replace('/sign/hall/', ''))
