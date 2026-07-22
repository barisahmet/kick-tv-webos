# Kick TV (Unofficial) for LG webOS

A small app for watching Kick livestreams on an LG webOS TV. It opens straight
into your last watched stream and gives you a sidebar of the channels you
follow (no sign-in, just local list), with live status, the game or category they are playing,
viewer counts, pinning, and low latency playback.

This is an unofficial, personal project. It is not affiliated with, authorized
by, or endorsed by Kick. The app reads Kick's
public web endpoints for personal use, so it can stop working at any time if
Kick changes something on their side. Use it at your own risk.

LG does not allow apps like this in the Content Store, so you install it
yourself in Developer Mode. The steps below walk through the whole thing from a
fresh TV. It takes about fifteen minutes the first time.

The easy way, if you do not want to build anything: turn on Developer Mode
(Step 1 below), download the ready made `.ipk` from the
[Releases](../../releases) page, and install it with the webOS Dev Manager app,
which is a friendly click based tool. That is all most people need. The rest of
the steps are for building it yourself from the command line.

## What you need

- An LG TV running webOS (this was built and tested on a 2022 model, webOS 22).
- A computer on the same network as the TV (Windows, macOS, or Linux).
- A free LG developer account.
- Node.js installed on the computer.

## Step 1. Turn on Developer Mode on the TV

1. Go to https://developer.lge.com and create a free account. You will sign in
   with this same account on the TV, so remember the email and password.
2. On the TV, open the Content Store (the LG app store) and search for
   "Developer Mode". Install the app called Developer Mode.
3. Open the Developer Mode app on the TV and sign in with your LG account.
4. Turn on Dev Mode Status. The TV will ask to restart. Let it restart.
5. Open the Developer Mode app again after the restart. You will now see the
   TV's IP address on the screen. Write it down.
6. Turn on the Key Server switch in that same screen. A short passphrase
   (six characters) appears. You will need the IP address and this passphrase
   in Step 3.

A couple of things worth knowing. Developer Mode runs on a timer and turns
itself off after roughly fifty hours. There is an auto renew option inside the
Developer Mode app, so turn that on if you want to leave it running. If Dev Mode
ever expires, any apps you sideloaded disappear, and you just enable it again
and reinstall.

## Step 2. Install the webOS command line tools

On your computer, install the CLI with npm:

```
npm install -g @webos-tools/cli
```

This gives you the `ares-setup-device`, `ares-package`, `ares-install`, and
`ares-launch` commands used below. You can check it worked by running
`ares-setup-device --list`.

If you would rather not use the command line at all, there is a friendly GUI
called webOS Dev Manager (a community tool you can find on GitHub). It lets you
register the TV and install an .ipk file by pointing and clicking. If you go
that route, do Step 1 above, download the built .ipk from the Releases page or
build it with Step 4, and install it through Dev Manager. You can skip Steps 3,
5, and 6.

## Step 3. Register your TV with the tools

Tell the CLI about your TV so it can talk to it:

```
ares-setup-device --add tv --info "host=YOUR_TV_IP" --info "port=9922" --info "username=prisoner"
```

Replace YOUR_TV_IP with the address from Step 1. The username is always
`prisoner` on webOS. The first time you install something, the tools use the
Key Server passphrase from Step 1 to fetch the login key from the TV, so keep
that passphrase handy. If you are prompted for it during install, type it in.

## Step 4. Build the app

From the folder where you cloned this project, build the package:

```
ares-package ./app ./services/com.barisahmet.kicktv.service -o .
```

This produces a file named `com.barisahmet.kicktv_1.0.0_all.ipk` in the current
folder. That single file is the whole app, front end plus the small background
service it needs.

## Step 5. Install it on the TV

```
ares-install --device tv com.barisahmet.kicktv_1.0.0_all.ipk
```

One thing to watch out for. Recent versions of Node.js removed an old helper
called `util.isDate`, and some builds of the webOS CLI still call it. If the
install fails with an error that says `isDate is not a function`, it is this and
not your setup. The quickest fix is to install through the webOS Dev Manager GUI
instead, which does not have the problem. If you want to stay on the command
line, create a small file that puts the helper back and preload it:

```
// shim.js
const util = require('util');
if (!util.isDate) util.isDate = (d) => Object.prototype.toString.call(d) === '[object Date]';
```

Then run the install with that file preloaded:

```
NODE_OPTIONS="--require ./shim.js" ares-install --device tv com.barisahmet.kicktv_1.0.0_all.ipk
```

## Step 6. Open it

You can launch it from the computer:

```
ares-launch --device tv com.barisahmet.kicktv
```

Or just find "Kick TV" on the TV's home row and open it like any other app.

## Using the app

- The first time you open it there are no channels yet, so it shows a short
  screen with an Add option. Add a channel by its Kick name and it appears in
  the list.
- After that it opens on the last channel you watched, if that channel is live.
  If none of your channels are live it tells you so, and you open the menu to
  pick another or add one.
- Move the pointer or press left to bring up the channel list on the side. It
  hides itself again after a few seconds.
- Click a channel to watch it. Hover a channel to reveal the pin and remove
  buttons on the right.
- Pinned channels float to the top while they are live.
- The plus at the top of the list, or the Add row at the bottom, lets you add a
  channel by its Kick name.
- Press Back once to bring up an exit prompt, and Back again to close the app.

## Setting your own channels

There is no built-in channel list. You add channels from inside the app and they
are saved on the TV. If you would rather ship a few defaults, put Kick channel
names (the part that comes after `kick.com/`) into the `SEED_FAVORITES` array in
`app/favorites.js`, which starts empty.

## How it works, briefly

A webOS app cannot call kick.com directly from the page because of browser
security rules, and Kick's network blocks the TV's default requests. To get
around that, the app ships a tiny background service that fetches Kick's data on
the app's behalf using browser like settings, then hands the video stream to the
TV's player. You do not have to do anything with this. It is bundled and
installed as part of the same package.

## Releasing

Pushing a version tag builds the `.ipk` and publishes it to the Releases page
automatically:

```
git tag v1.0.0
git push origin v1.0.0
```

## License

The code in this project is MIT licensed. See LICENSE. It bundles the hls.js
video library, which has its own license. See THIRD_PARTY_LICENSES.md for that.
