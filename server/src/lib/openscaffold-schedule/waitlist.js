/**
 * @openscaffold/scheduling — Priority Waitlist & Instant Slot Offer Matcher
 */

function matchWaitlistForCanceledSlot(waitlistEntries = [], canceledSlot) {
  const candidates = waitlistEntries
    .filter(w => w.status === 'waiting' && (w.party_size || 1) <= (canceledSlot.capacity || 4))
    .sort((a, b) => {
      if ((b.priority_score || 0) !== (a.priority_score || 0)) {
        return (b.priority_score || 0) - (a.priority_score || 0);
      }
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    });

  return candidates[0] || null;
}

module.exports = {
  matchWaitlistForCanceledSlot,
};
