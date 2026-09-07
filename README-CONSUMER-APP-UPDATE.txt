SnapAppraisal consumer app update (7 Sep 2026)
==============================================
Builds on consumer-app-warm-lead-photos.zip (includes that fix too).

FILES (thedanielwest-crypto/bright-property-snap-appraisal)
  index.html      <- replace
  logo-light.svg  <- NEW file, drag-and-drop into the repo root
                     (it's the brand pack Vector Master, black + orange on transparent)

CHANGES
  1. Landing page rebuilt to match the mockup:
       white logo panel (light Snap Appraisal logo) at the top
       -> AGENCY NAME (large) -> "Snap Appraisal" -> "Let's get started"
       -> intro sentence -> big round agent headshot -> "Let's Get Started" button
  2. Light Snap Appraisal logo now sits at the top-left of every page header
     (Capture, Meet your agent, Anything else?, Appraise It).
  3. Capture screen: new "Upload a photo from your phone or computer" button
     under "Take Photo" – opens the gallery / file picker instead of the camera.
     Same upload + blur + Looks Good flow afterwards.
  4. "Anything else?" icons replaced with Snap-frame style SVG icons
     (brand bracket corners in orange + black, simple line glyph inside).
     Same icons show on the capture screen and the room strip.
  5. "Anything else?" flow: tapping a feature opens the capture screen for
     just that feature; after Looks Good (or Skip) it returns to
     "Anything else?" with that card ticked "Photographed". Repeat as many as
     they like, then "Finished Taking Photos" goes to Appraise It.
     (Old Continue / Skip to Appraise It buttons removed.)
  6. Warm-lead progress sync after every photo (from the earlier zip).

NO ENV / DB / FUNCTION CHANGES. Netlify redeploys on commit.
featuresSelected sent to Airtable/Supabase = features actually photographed.

TEST
  1. Open your app link -> landing shows white logo panel, agency name, headshot
  2. Take Photo still opens the camera on phone; Upload opens gallery/files
  3. Anything else? -> tap Pool -> photo -> Looks Good -> back on Anything else?
     with Pool ticked -> tap Garage -> Skip -> back, Garage NOT ticked
  4. Finished Taking Photos -> Appraise It -> submit -> Hot Lead lists pool
