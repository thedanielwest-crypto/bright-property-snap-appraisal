SnapAppraisal consumer app update 3 (13 Sep 2026)
=================================================
Builds on consumer-app-update-2.zip (everything from it is included).

FILE (thedanielwest-crypto/bright-property-snap-appraisal)
  index.html   <- replace

CHANGES
  1. GENERIC DEMO DEFAULTS. The root link (app.austsnapappraisal.com with no
     agent slug) is now a generic selling tool:
       "Bright Property Townsville" -> "Your Business Name Here"
       "Rob Levy" / "Rob"            -> "Your Name Here" / "your agent"
       Rob's headshot                -> neutral placeholder avatar
       "Townsville born"             -> "Local expert"
     Changed everywhere: page title, landing, capture header, Meet your agent,
     Appraise It trust line, You're all set, Can't wait?.
     Real agent links (/roblevy, /danielwest ...) are unaffected: everything is
     still filled from their portal branding. The Appraise It trust line now
     personalises too (it used to say "Rob at Bright Property" for everyone).

  2. FULL-SIZE PHOTOS. Root cause of the tiny photos: the app uploaded the
     on-screen PREVIEW canvas (~380 x 150px, cropped to a letterbox). Now:
       - an offscreen full-resolution copy is kept, long edge capped at
         1600px, JPEG quality 0.85  -> typically 300-500KB per photo
       - that copy is what's uploaded to Cloudinary
       - the preview shows the WHOLE photo (no cropping), box is taller (230px)
       - blur strokes are applied to both the preview and the full-res copy
         (same spot, scaled), Undo restores both
     Constants at the top of the blur block if you ever want to change them:
       PHOTO_MAX_EDGE = 1600, PHOTO_JPEG_QUALITY = 0.85

     Why 1600px: it's the size the major listing portals serve, sharp on any
     phone/desktop and in the portal lightbox, and cheap:
       ~0.4MB x 10 photos = 4MB per appraisal
       1,000 appraisals  = ~4GB  (Cloudinary free tier: 25GB storage/bandwidth)
     Going to 2400px roughly doubles storage for no visible gain on screen.

NO ENV / DB / FUNCTION CHANGES. Existing photos stay small; new ones are full size.

TEST
  1. app.austsnapappraisal.com (no slug) -> "YOUR BUSINESS NAME HERE" / "Your Name Here"
  2. app.austsnapappraisal.com/<your slug> -> your name/agency everywhere as before
  3. Take a photo -> preview shows the full frame -> blur a bit -> Looks Good
     -> portal lightbox shows a sharp full-frame photo (~1600px wide)
