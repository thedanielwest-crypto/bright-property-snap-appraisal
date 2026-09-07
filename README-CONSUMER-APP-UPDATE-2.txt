SnapAppraisal consumer app update 2 (7 Sep 2026)
================================================
SUPERSEDES consumer-app-landing-icons-extras.zip (everything from it is here).

FILES (thedanielwest-crypto/bright-property-snap-appraisal)
  index.html                              <- replace
  logo-light.svg                          <- replace (tagline removed)
  netlify/functions/get-agent-by-slug.js  <- replace (now returns the agent's phone)

CHANGES
  1. Logo: tagline removed on every page (landing panel + page headers).
  2. "Anything else?" icons back to the simple emoji ones.
  3. "Other" card (dashed): tap -> type what it is -> Add -> straight into
     photographing it; it then sits in the grid as its own card. Max 5.
  4. Undo blur button appears under the photo after the first blur stroke;
     each tap undoes one stroke (up to 20). Clears on retake / next photo.
  5. Final page: "Can't wait?" box with
       Call <mobile>   -> tel: link
       Email <Name>    -> mailto: prefilled:
          Subject: Keen to get started – <property address>
          Body:    Hi <First>, I'm keen to get started so please contact me
                   about selling my home at <address>. Thanks
     Buttons only show when the agent has that detail saved.
  6. Final page: "Add another appraisal" -> back to the very start (fresh session).
  7. Fix: the app never had a .hidden CSS rule – added (it was relying on
     empty text to hide things).

NEEDS THE PORTAL ZIP TOO (agent-portal-phone-field.zip) + the SQL migration,
otherwise the Call button simply won't show (email still works – it's already stored).

TEST
  1. Anything else? -> Other -> "Wine cellar" -> Add -> capture screen -> Looks Good
     -> back with "Wine cellar" ticked. Add 5 -> Other card greys out.
  2. Photo -> drag to blur -> Undo blur -> stroke gone.
  3. Submit -> Can't wait? shows Call + Email -> Email opens mail app prefilled.
  4. Add another appraisal -> landing page.
