// @openscaffold/schedule v0.1.0 integration test for OpenChurch (DOC-08)
// Verifies MODE_C_EVENT_FACILITY_TEE (sanctuary, fellowship hall, classroom, youth room & AV holds),
// @openscaffold/catering fellowship dinner integration, MODE_D_SHIFT_ROSTER volunteer rosters,
// RFC 5545 .ics feeds (/api/schedule/feed.ics), /.well-known/agent-booking.json, and STD-21 MCP tools.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import request from 'supertest'
import app from '../src/app.js'

const require = createRequire(import.meta.url)
const {
  CALENDAR_MODES,
  SCHEDULE_ACTION_TOOLS,
  evaluateModeCFacilityOrTeeBooking,
  generateTenantIcsFeed,
} = require('../src/lib/openscaffold-schedule/index.js')

let server

beforeAll(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
})

afterAll(async () => {
  if (server) {
    await new Promise(resolve => server.close(resolve))
  }
})

describe('@openscaffold/schedule v0.1.0 in OpenChurch (MODE_C_EVENT_FACILITY_TEE + MODE_D_SHIFT_ROSTER)', () => {
  it('maps open-church to MODE_C_EVENT_FACILITY_TEE and exposes STD-21 MCP tools', async () => {
    const modeRes = await request(server).get('/api/schedule/mode')
    expect(modeRes.status).toBe(200)
    expect(modeRes.body.primary_mode).toStrictEqual(CALENDAR_MODES.MODE_C_EVENT_FACILITY_TEE)
    expect(modeRes.body.secondary_mode).toStrictEqual(CALENDAR_MODES.MODE_D_SHIFT_ROSTER)
    expect(SCHEDULE_ACTION_TOOLS.map(t => t.name)).toEqual(
      expect.arrayContaining([
        'schedule.check_availability',
        'schedule.book_slot',
        'schedule.move_or_cascade',
        'schedule.fill_waitlist',
      ])
    )
  })

  it('serves /.well-known/agent-booking.json with MODE_C_EVENT_FACILITY_TEE, MODE_D_SHIFT_ROSTER, and @openscaffold/catering', async () => {
    const res = await request(server).get('/.well-known/agent-booking.json')
    expect(res.status).toBe(200)
    expect(res.body.standard).toBe('OSL-AGENT-BOOKING-v1')
    expect(res.body.calendar_mode).toBe('MODE_C_EVENT_FACILITY_TEE')
    expect(res.body.secondary_mode).toBe('MODE_D_SHIFT_ROSTER')
    expect(res.body.catering_integration).toContain('@openscaffold/catering')
    expect(res.body.mcp_tools).toContain('schedule.check_availability')
  })

  it('serves static sample RFC 5545 .ics feed on /api/schedule/feed.ics', async () => {
    const res = await request(server).get('/api/schedule/feed.ics?parish=st-brigids')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/calendar')
    expect(res.text).toContain('BEGIN:VCALENDAR')
    expect(res.text).toContain('Sample: Sunday Morning Worship')
    expect(res.text).toContain('Wednesday Fellowship Hall Dinner')
  })

  it('evaluates MODE_C_EVENT_FACILITY_TEE sanctuary/fellowship hall holds and links @openscaffold/catering fellowship dinners', async () => {
    const directEval = evaluateModeCFacilityOrTeeBooking({
      orgId: 'org_church_1',
      verticalKey: 'open-church',
      bookingSubtype: 'facility_room_hold',
      candidateStartIso: '2026-10-28T18:00:00.000Z',
      candidateEndIso: '2026-10-28T20:00:00.000Z',
      partySize: 85,
      existingBookings: [],
    })
    expect(directEval.allowed).toBe(true)

    const res = await request(server)
      .post('/api/schedule/facility-hold')
      .send({
        facility_zone: 'fellowship_hall',
        booking_subtype: 'facility_room_hold',
        starts_at: '2026-10-28T18:00:00.000Z',
        ends_at: '2026-10-28T20:00:00.000Z',
        expected_attendance: 85,
        av_hold_required: true,
        includes_fellowship_dinner: true,
        catering_headcount: 85,
      })
    expect(res.status).toBe(200)
    expect(res.body.mode.mode).toBe('MODE_C_EVENT_FACILITY_TEE')
    expect(res.body.facility_zone).toBe('fellowship_hall')
    expect(res.body.evaluation.allowed).toBe(true)
    expect(res.body.catering_handoff.module).toBe('@openscaffold/catering')
    expect(res.body.catering_handoff.estimated_guests).toBe(85)
  })

  it('evaluates MODE_D_SHIFT_ROSTER volunteer ministry rotation rosters and STD-21 MCP tools', async () => {
    const rosterRes = await request(server)
      .post('/api/schedule/volunteer-roster')
      .send({
        service_title: 'Sunday 10:00 AM Sanctuary Worship',
        assignments: [
          { volunteer_id: 'vol_1', name: 'Hannah Grace', role: 'worship_leader' },
          { volunteer_id: 'vol_2', name: 'Lucas Reed', role: 'av_tech' },
          { volunteer_id: 'vol_3', name: 'Miriam Cho', role: 'usher_greeter' },
          { volunteer_id: 'vol_4', name: 'David Park', role: 'nursery_lead' },
        ],
      })
    expect(rosterRes.status).toBe(200)
    expect(rosterRes.body.mode.mode).toBe('MODE_D_SHIFT_ROSTER')
    expect(rosterRes.body.roster_complete).toBe(true)
    expect(rosterRes.body.missing_roles).toEqual([])

    const mcpGet = await request(server).get('/api/schedule/mcp')
    expect(mcpGet.status).toBe(200)
    expect(mcpGet.body.tools.length).toBe(8)

    const mcpPost = await request(server)
      .post('/api/schedule/mcp')
      .send({
        tool: 'schedule.check_availability',
        input: {
          facility_zone: 'sanctuary',
          starts_at: '2026-10-25T16:00:00.000Z',
          ends_at: '2026-10-25T18:00:00.000Z',
          party_size: 150,
        },
      })
    expect(mcpPost.status).toBe(200)
    expect(mcpPost.body.ok).toBe(true)
    expect(mcpPost.body.availability.allowed).toBe(true)

    const ics = generateTenantIcsFeed({
      orgId: 'st-brigids',
      calendarName: 'St. Brigid Parish',
      bookings: [
        {
          id: 'evt_1',
          client_name: 'Youth Ministry',
          service_name: 'Youth Room Worship Night',
          starts_at: '2026-10-30T01:00:00.000Z',
          ends_at: '2026-10-30T03:00:00.000Z',
          status: 'confirmed',
        },
      ],
    })
    expect(ics.event_count).toBe(1)
  })
})
