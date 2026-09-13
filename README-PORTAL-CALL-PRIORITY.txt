SnapAppraisal Agent Portal – "Client requesting call" priority (13 Sep 2026)
============================================================================
SUPERSEDES agent-portal-founders-fix.zip (that fix is included here).

FILES (thedanielwest-crypto/snapappraisal-agent-portal)
  index.html                              <- replace
  netlify/functions/send-lead-email.js    <- replace (call banner in the email)

CHANGES
  Hot Leads:
    - leads where the client asked for a call (contact preference "Call" +
      mobile) sort to the TOP, above everything else
    - pulsing orange "📞 Client requesting call" pill + tinted row with an
      orange left bar
    - lead detail modal shows an orange banner with a tap-to-call number
    - "Send it to me" email (Resend + mailto fallback) starts with
      "CLIENT REQUESTING A CALL · <mobile>"
  Founders drill-down fix from the previous zip is included.

NO ENV / DB CHANGES.

TEST
  Hot Leads -> a call-request lead sits first with the pulsing pill ->
  open it -> orange banner with the number -> Send it to me -> banner in email.
