SnapAppraisal consumer app update 4 (13 Sep 2026)
=================================================
SUPERSEDES consumer-app-update-3.zip (generic defaults + full-size photos are in here too).

FILE (thedanielwest-crypto/bright-property-snap-appraisal)
  index.html   <- replace

CHANGES
  1. "Appraise It" now asks for NAME + EMAIL only (both required, email
     validated). Mobile field and contact-preference buttons removed.
  2. After "Get My Appraisal", the "You're all set" page shows a highlighted
     card: "📞 Want a call from <Agent>?" with a mobile field and
     "Yes, call me →". On success it flips to "Done! <Agent> will call you
     on <mobile>." The Can't wait? and Add another appraisal blocks stay below.
  3. Under the hood the call request UPDATES THE SAME HOT LEAD (same
     record/session) with mobile + contact preference "Call". No new
     fields, no function changes, no migration: submit-lead.js already
     stores both, in Airtable and Supabase.

TEST
  1. Complete an appraisal with name + email only -> hot lead appears in the
     portal with preference Email, no mobile.
  2. On the You're all set page enter a mobile -> Yes, call me -> the SAME
     hot lead now shows mobile + "Client requesting call" at the top.
