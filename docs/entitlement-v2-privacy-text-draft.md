# Draft: privacy-policy text for entitlement version 2

Status: draft, 20 November 2026. Not in effect. `docs/privacy-policy.md`
describes what is live and is not changed until version 2 ships. The
rules behind this text are in `docs/sync-protocol.md` §Entitlement
version 2 (planned) and `docs/threat-model.md` T15.

## Notes for the editor (not policy text)

- Add the section "Buying Sitr Family" below after "The iOS and Android
  apps", and replace the two paragraphs marked "replaces" in place.
- The current policy never names Polar. Version 2 must, because the
  website sells through it.
- The sentence "We hold no personal data about you" in "Your rights"
  stops being exact: the claim service stores a keyed hash of a
  subscription ID, which is pseudonymous data. The replacement below says
  so.
- Store forms change with it: the Apple App Privacy label and the Google
  Play Data safety form will probably gain "Purchases" (a record of a
  purchase is now stored). Answer them from this text.
- Facts still to confirm before publishing: what Polar's dashboard shows
  the seller (assumed below: name, email, country, amount and renewal
  dates), and what Apple shares with developers (assumed below: no buyer
  identity, sales reports only), that Polar offers buyers a customer
  portal to cancel, and that the portal page (not only its API) shows the
  subscription ID.
- "Checking service" in the policy text is the "claim service" of the
  spec; the policy uses the plainer word.
- Update the "Effective / updated" line on the day version 2 ships.

## Policy text

### Buying Sitr Family

Sitr Family is a subscription, monthly or yearly. Sitr itself has no
accounts and asks for no name or email.

**In the iOS app.** You pay Apple through the App Store. Apple handles
the payment and your Apple ID; Apple does not tell us who you are. The
app sends Apple's signed record of the purchase to our checking service
to get a token for your household. That record contains the purchase's
ID numbers, the product, its dates, your App Store country and the price;
the service reads only what it needs to check the purchase (the app,
the product, the subscription's and the purchase's ID numbers, the
expiry and whether it was refunded) and keeps none of it. Apple tells
our service when a purchase is refunded or revoked, so no further token
is issued for that purchase.

**On the website.** You pay Polar, which sells Sitr for us as merchant of
record. Polar collects your name, email, address and payment details, and
shows us your order (including your name, email, country, the amount and
the renewal dates) in its dashboard, as any merchant of record does for
the seller. Polar's own privacy policy covers what Polar does with them.
After checkout you get a subscription code: the ID Polar gives your
subscription, which you can also read through Polar's customer portal.
Polar does not treat it as a secret, and we, as the seller, can see it
too. You enter it once in the extension or the Android app; the device
then gets each month's token by itself. The first device that does so is
tied to your subscription by a random secret it keeps; another device can
take over only once in 180 days, or after the first one has stopped
renewing. Our checking service sends the code to Polar and reads only
the subscription's status, product, billing interval and the end of the
paid period. Polar's answer also contains your name, email and address; the
service keeps only the four items above and stores and logs nothing
else.

**What our servers store.** The checking service runs separately from
the sync server, at claim.sitrshield.com, with its own storage; the two
share no key or data. Your device contacts it only to renew, so someone
watching your network can see that your device renews a subscription,
though not which one. While your subscription renews, the
checking service stores a keyed hash of your subscription's ID number (a
value from which the ID cannot be read back), a keyed hash of the random
secret your renewing device keeps, and the last month it renewed for
(the same for everyone who renewed for that month); it deletes them
once the last token has expired, a few days into the first month without
a renewal. If an App Store purchase was refunded, it stores a keyed hash
of that purchase's ID number and its end date, until that date (at most
the rest of the period paid, up to a year). If another device took over your
subscription, it stores the day, for 180 days. Until the old version 1
tokens are retired, it also stores a keyed hash of each checkout that
received one, with that token's expiry. It stores no name, no email, no
IP address and no token. The sync server stores, for each household, the date its
subscription runs until, which is the same date for every household that
renewed that month, and a list of used tokens (a hash and an end date
each, with no household attached), deleted when each token expires. No
stored value links your household to your subscription.

Two limits, stated plainly. Someone who holds our checking service's key
and already knows a subscription's ID number can test whether it is in
our records; for website purchases we know every subscription's ID from
Polar, so we could match each of these records to a named website buyer
(not to a household). And someone who compares copies of our databases taken at
different times can see when a household first appeared and in which
month it stopped renewing, and when a subscription started and stopped
claiming; with few subscribers such moments can be matched, and Polar's
dashboard shows us when each website buyer bought and cancelled. Our
servers keep no request logs, so we do not record which device asked for
which token.

**When a subscription ends.** Your household becomes read-only: every
device keeps filtering with its last settings, and changes do not sync
until you renew. Tokens are issued per calendar month, so after a
cancellation the household keeps syncing until a few days after the end
of the month in which the paid period ended. Nothing is deleted then;
the household's encrypted blob is deleted after 18 months without a
write, as before. Purchases made by
Apple's reviewers and test users (Apple's sandbox) create test households,
which are deleted after 7 days.

**Your household key in iCloud Keychain (iPhone and iPad).** The app can
keep your household's key in iCloud Keychain, together with the secret
that renews your subscription, so your other Apple devices and a
restored iPhone can rejoin and renew without the pairing code. It is on by
default, and you can turn it off in the app; turning it off removes the
copy from iCloud Keychain. The key goes to Apple's iCloud Keychain, never
to us. Anyone who can sign in to your Apple ID on a new device and
unlock iCloud Keychain gets the key, and with it the household, just as
anyone who holds the pairing code does.

### What Sitr stores on your device (replaces the last two sentences of the first paragraph)

The opt-in lists, the DNS filter setting and the wait setting are not
part of that blob: they are never sent to us. If you use Sitr Family, the
extension and the Android app also store your subscription code, every
app stores the random secret that renews your subscription (sent only to
our checking service, never in the household blob), and every app stores
the current token. On iPhone and iPad, iOS includes the
app's settings (not the household's encryption key) in your own device
backup, if you make one; if you leave "Keep the household key in iCloud
Keychain" on, the key is kept in iCloud Keychain instead. The Android app
opts out of device backups.

### Your rights (GDPR/CCPA) (replaces the paragraph's opening, up to "email privacy@dooplin.com"; the rest stays)

We hold almost no personal data about you. The household blob is
ciphertext we cannot read, tied to no account, name, or email. If you
subscribe, our checking service holds a keyed hash of your
subscription's ID number while the subscription renews (longer only
after a takeover by another device, or until version 1
tokens are retired, as described above); this is pseudonymous data.
Polar, as merchant of record, holds your order for website purchases,
and Apple holds App Store purchases. To cancel, use Apple's subscription
settings or Polar's customer portal. Leaving a household deletes its data
from your device, and the server deletes a household blob that has not
been written to for 18 months. To have it deleted sooner, email
privacy@dooplin.com.
