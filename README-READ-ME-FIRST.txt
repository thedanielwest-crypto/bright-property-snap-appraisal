!!! CONSUMER APP IS CURRENTLY BROKEN – READ THIS FIRST !!!  (14 Sep 2026)
=======================================================================
app.austsnapappraisal.com is serving the AGENT PORTAL's index.html right now
(title "SnapAppraisal, Agent Portal (Prototype)", it has "Purchase Mail Out"
in it). The portal file was committed into the consumer app repo by mistake.
Every agent link (app.austsnapappraisal.com/roblevy etc) currently shows the
portal login instead of the photo walkthrough.

FIX: replace index.html in thedanielwest-crypto/bright-property-snap-appraisal
with the index.html IN THIS ZIP (it is the consumer app, update 4 – title
"Snap Appraisal, Your Business Name Here").

Also make sure these two are in that repo (from earlier zips, included again):
  logo-light.svg                            (repo root)
  netlify/functions/get-agent-by-slug.js    (returns the agent's phone)

WHAT THIS index.html CONTAINS (everything from updates 1-4)
  - full-resolution photo uploads (1600px long edge) – fixes the tiny photos
  - warm-lead photo sync after every room
  - generic "Your Business Name Here" demo on the root link
  - name + email only, then "Want a call?" step (Client requesting call)
  - Undo blur, Other features (max 5), light logo, Can't wait?, Add another appraisal

CHECK AFTER DEPLOY
  app.austsnapappraisal.com  -> dark landing page with "YOUR BUSINESS NAME HERE"
  app.austsnapappraisal.com/roblevy -> Rob's branded landing page
