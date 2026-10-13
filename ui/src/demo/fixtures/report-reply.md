**First decision to make: where does the shop run in production?** The repo has two half-finished hosting setups. Render is what the README and the launch checklist describe. Fly.io + Supabase is newer (added last month, PRs #61/#67). Nothing else on the launch path can move until you pick one.

## Where things stand
- **Done:** sign-in (email magic links plus Google), product catalogue, cart, Stripe checkout, order emails, the new product page, removing the old wishlist. 214 web tests and all API tests pass.
- **Not started:** everything in the launch checklist (hosting, secrets, domain, payments in live mode, monitoring). It's all still marked ❌. The checklist was last updated 2026-09-02; `ROADMAP.md` (2026-08-20) is older and also stale.

## Do now: code fixes, about half a day in total
1. **Broken link:** `web/src/pages/OrderDone.tsx:42` and `:97` go to an `/account/wishlist` page that no longer exists. About 15 min.
2. **Stale env var:** `api/render.yaml:18` still says `PAYPAL_SANDBOX`; it should be `STRIPE_TEST_MODE`. About 5 min.
3. **Stale secret name:** both prod and staging configs still create `PAYPAL_SECRET`; it should be `STRIPE_SECRET_KEY`. About 15 min.
4. **No prod database:** `infra/prod/main.tf` has no database module. Only needed if you stay on Render. About 1–2 h.
5. **CI can't deploy:** 4 deploy workflows still have `echo "TODO"` instead of credentials. About 1 day, and again only if you stay on Render.

## Manual steps only you can do
1. Switch the Stripe account to live mode and add the production webhook URL.
2. Create the production email sender and verify the domain.
3. Publish the terms and privacy pages at `shop.example.com/terms` and `/privacy`. The checkout already links there; the links are dead right now.
4. Register the business with the payment provider for payouts. **Payout verification is the long pole:** it can take up to 10 business days. Start this first.
5. Set up the domain and DNS for the API.

## Product follow-ups (from the 2026-10-01 review)
- The "recently viewed" strip lived on the wishlist page, so it needs a new place.
- Multi-currency prices are parked. The shop shows euros only for launch.
- Product photos and the category banners use two different styles.
- Error tracking isn't in the web app yet (fine to add after launch).

Next: tell me "Render" or "Fly". I'll update the checklist to match and fix items 1–3 in this worktree (about 30 min). You can start the payout verification in parallel.
