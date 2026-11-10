# Group Safety prototype (v0.1)

A web page that lets a small group share live locations during a trip and alerts everyone if someone hasn't checked in as home safe by their expected arrival time. Test prototype for validation only: adults only, not an emergency service.

## What it does
- Create a group or join one with an 8-character code or invite link
- Start a trip with a destination and expected arrival time; location is shared while the page is open
- Live group map and list with "last seen", battery (where the browser allows) and trip status
- Overdue alert for everyone in the group; "+15 min" / "+30 min" to extend; "I'm home safe" stops sharing
- Leave group deletes your data; anything not updated for 24 hours is deleted automatically

## Limits (fixed in the real app)
- Sharing pauses when the screen locks or you switch apps (the page asks the screen to stay on)
- No notifications to phones that don't have the page open
- Battery level isn't available in Safari on iPhone

## Set-up
1. **Database:** in Supabase, open SQL Editor > New query, paste the whole of `schema.sql`, and click Run.
2. **Keys:** put the Supabase project URL and publishable key (`sb_publishable_...`) in `config.js`. Never use the secret key.
3. **Hosting:** in this GitHub repository, Settings > Pages > Source: Deploy from a branch > `main` / `(root)` > Save. The site appears at `https://<username>.github.io/<repository>/` after a minute or two.

## How it's built
- `index.html` and `app.js`: the page (Leaflet map with OpenStreetMap tiles, supabase-js 2.118.0)
- `schema.sql`: tables locked by row level security; the page can only call functions that check each member's secret
