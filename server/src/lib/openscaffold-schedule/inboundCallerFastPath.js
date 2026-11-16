/**
 * @openscaffold/schedule — Inbound Caller Fast-Path & xAI Voice Agent API Pilot
 * Implements IDEA-2026-10-25-01 & IDEA-2026-10-25-05:
 *  - buildXaiVoiceAgentReceptionistConfig(): configures xAI Voice Agent API (free inbound phone
 *    number provisioning, 100+ languages multilingual speech-to-speech, native Twilio SIP/Media-Streams
 *    compatibility, and direct zero-hold tool-call bridge into schedule.check_availability / schedule.book_slot).
 *  - evaluateVoiceReceptionistUnitEconomics(): compares per-minute unit economics of xai_voice_agent_api
 *    vs. stitched Twilio + Deepgram Nova-3 STT + ElevenLabs Flash TTS, enforcing a fail-closed
 *    max_allowed_per_minute_cents guard.
 */

const {
  handleInboundAgentCaller,
  buildPublicAgentBookingManifest,
  prepareOutboundOwnerPhoneCall,
  recordCompletedOutboundCallTranscript,
} = require('./agentBookingEndpoint');

const DEFAULT_SUPPORTED_LANGUAGES = [
  'en', 'es', 'zh', 'fr', 'vi', 'tl', 'ko', 'ja', 'de', 'pt', 'ar', 'hi', 'ru', 'it',
];

function buildXaiVoiceAgentReceptionistConfig({
  orgId,
  verticalKey = 'open-dentist',
  businessName = 'Open Scaffold Practice',
  provider = 'xai_voice_agent_api',
  twilioSipDomain = null,
  provisionFreeInboundNumber = true,
  supportedLanguages = DEFAULT_SUPPORTED_LANGUAGES,
  maxAllowedPerMinuteCents = 8,
  baseUrl = 'https://app.openscaffold.org',
}) {
  if (!orgId) {
    throw new Error('orgId is required for voice receptionist configuration');
  }

  const cleanBase = String(baseUrl).replace(/\/+$/, '');

  return {
    idea_id: 'IDEA-2026-10-25-05',
    org_id: orgId,
    vertical_key: verticalKey,
    business_name: businessName,
    provider,
    telephony: {
      free_inbound_number_provisioned: Boolean(provisionFreeInboundNumber && provider === 'xai_voice_agent_api'),
      twilio_sip_media_streams_compatible: true,
      twilio_sip_domain: twilioSipDomain || `${orgId}.sip.twilio.com`,
      outbound_calling_std04_gated: true,
      tcpa_compliant_agent_disclosure: true,
    },
    multilingual: {
      auto_detect_language: true,
      total_supported_languages_count: 100,
      priority_languages: supportedLanguages,
    },
    zero_hold_fast_path: {
      hold_time_seconds: 0,
      dtmf_agent_bypass: '#9',
      mcp_endpoint: `${cleanBase}/api/agent/mcp`,
      well_known_booking_url: `${cleanBase}/.well-known/agent-booking.json`,
      bridged_tools: [
        'schedule.check_availability',
        'schedule.book_slot',
        'schedule.move_or_cascade',
        'schedule.fill_waitlist',
      ],
    },
    cost_guard: {
      max_allowed_per_minute_cents: maxAllowedPerMinuteCents,
      fail_closed_on_rate_exceeded: true,
    },
  };
}

function evaluateVoiceReceptionistUnitEconomics({
  monthlyInboundMinutes = 1500,
  xaiVoiceAgentPerMinuteCents = 5.0,
  twilioVoicePerMinuteCents = 1.4,
  deepgramSttPerMinuteCents = 0.8,
  elevenLabsTtsPerMinuteCents = 5.5,
  llmOrchestrationPerMinuteCents = 1.5,
  maxAllowedPerMinuteCents = 8.0,
} = {}) {
  const stitchedStackPerMinuteCents = Number(
    (
      twilioVoicePerMinuteCents +
      deepgramSttPerMinuteCents +
      elevenLabsTtsPerMinuteCents +
      llmOrchestrationPerMinuteCents
    ).toFixed(2)
  );

  const xaiWithinCap = xaiVoiceAgentPerMinuteCents <= maxAllowedPerMinuteCents;
  const stitchedWithinCap = stitchedStackPerMinuteCents <= maxAllowedPerMinuteCents;

  const xaiMonthlyCents = Math.round(monthlyInboundMinutes * xaiVoiceAgentPerMinuteCents);
  const stitchedMonthlyCents = Math.round(monthlyInboundMinutes * stitchedStackPerMinuteCents);
  const monthlySavingsCents = stitchedMonthlyCents - xaiMonthlyCents;

  return {
    idea_id: 'IDEA-2026-10-25-05',
    monthly_inbound_minutes: monthlyInboundMinutes,
    max_allowed_per_minute_cents: maxAllowedPerMinuteCents,
    providers: {
      xai_voice_agent_api: {
        inbound_number_monthly_fee_cents: 0,
        per_minute_cents: xaiVoiceAgentPerMinuteCents,
        monthly_total_cents: xaiMonthlyCents,
        within_rate_cap: xaiWithinCap,
        status: xaiWithinCap ? 'APPROVED_PILOT' : 'BLOCKED_RATE_CAP_EXCEEDED',
      },
      stitched_twilio_deepgram_elevenlabs: {
        inbound_number_monthly_fee_cents: 115,
        per_minute_cents: stitchedStackPerMinuteCents,
        monthly_total_cents: stitchedMonthlyCents + 115,
        within_rate_cap: stitchedWithinCap,
        status: stitchedWithinCap ? 'APPROVED_FALLBACK' : 'BLOCKED_RATE_CAP_EXCEEDED',
      },
    },
    selected_provider: xaiWithinCap
      ? 'xai_voice_agent_api'
      : stitchedWithinCap
        ? 'stitched_twilio_deepgram_elevenlabs'
        : 'FAIL_CLOSED_FALLBACK_TO_MISSED_CALL_SMS',
    monthly_savings_cents: monthlySavingsCents + 115,
    savings_pct: Number(
      ((((stitchedMonthlyCents + 115) - xaiMonthlyCents) / (stitchedMonthlyCents + 115)) * 100).toFixed(1)
    ),
  };
}

module.exports = {
  handleInboundAgentCaller,
  buildPublicAgentBookingManifest,
  prepareOutboundOwnerPhoneCall,
  recordCompletedOutboundCallTranscript,
  buildXaiVoiceAgentReceptionistConfig,
  evaluateVoiceReceptionistUnitEconomics,
};
