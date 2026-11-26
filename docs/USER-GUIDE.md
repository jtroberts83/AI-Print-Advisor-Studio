# User guide

This guide takes you from "I downloaded a model" to "it's printing", one step at a time. No 3D printing knowledge needed: every new word is explained in the [glossary](#glossary) at the end.

**Quickest way to learn:** the **guided tour** that starts the first time you open the app. It walks you through all of this with a sample rocket.

---

## Contents

1. [First start](#1-first-start)
2. [Getting an Anthropic API key](#getting-an-anthropic-api-key) (or using a free chatbot)
3. [Open a model](#3-open-a-model)
4. [Check the toolheads (colors)](#4-check-the-toolheads-colors)
5. [Place it on the bed (orientation)](#5-place-it-on-the-bed-orientation)
6. [Choose quality or speed](#6-choose-quality-or-speed)
7. [Get recommended settings](#7-get-recommended-settings)
8. [Compare versions](#8-compare-versions)
9. [Save it or print it](#9-save-it-or-print-it)
10. [Color remix](#10-color-remix)
11. [Your filament library](#11-your-filament-library)
12. [When a print fails: the troubleshooter](#12-when-a-print-fails-the-troubleshooter)
13. [Models from MakerWorld (Bambu Lab files)](#13-models-from-makerworld-bambu-lab-files)
14. [Keeping an eye on AI costs](#14-keeping-an-eye-on-ai-costs)
15. [Watching your prints: the Print Monitor](#15-watching-your-prints-the-print-monitor)
16. [Glossary](#glossary)

---

## 1. First start

1. Double-click **`AI 3D Print Advisor Studio.exe`**. It's the only program in the folder; the `app` folder beside it holds the app's files (keep the two together if you move them).
   If Windows says **"Windows protected your PC"**, click **More info → Run anyway**. To avoid that warning, right-click the zip **before extracting** → **Properties** → tick **Unblock** → **OK** (see the [FAQ](FAQ.md#windows-says-windows-protected-your-pc)).
2. **The guided tour starts** (first launch only). It asks **how much 3D printing experience you have**, then walks you through every feature on a sample rocket with recorded results, shows you the **Glossary**, and where to put your **API key** (and why). Click **Finish the tour** at the end: the app restarts, ready for your own models, with an empty filament library. It won't run again; **Settings → Take the guided tour again** replays it.
   About the experience level: Pick honestly: "Brand new" turns on the step-by-step guide and extra tips. The guide puts a pulsing orange **Click here** ring on the next button to press (also inside windows like Color remix) and moves itself out of the way. "Brand new" and "A little" also **explain 3D printing words**: words with a dotted underline show what they mean, with a picture, when you hover over them (see [Words you don't know](#words-you-dont-know)). You can change all of this later in Settings.
3. The app looks for **Snapmaker Orca** on your computer. The bar at the top says when it's ready. If it can't find it, open **Settings** (the gear, top right) and click **Browse** next to "Snapmaker Orca program".
4. Click the **gear** to open **Settings** and:
   - choose how to get AI advice (next section),
   - add your **printers** (optional): click **Find printers on my network**, or type each printer's address (the one you'd open Fluidd or Mainsail with, like `192.168.1.50`).

Click **Save**.

---

## Getting an Anthropic API key

The app's AI is **Claude**, made by Anthropic. You can use it two ways:

**A. API key (automatic, a few cents per request)**

1. Go to **[platform.claude.com](https://platform.claude.com/)** and sign up (it's separate from a Claude.ai chat subscription; you don't need one).
2. Under **Billing**, add a little credit. $5 lasts most people a long time.
3. Under **API keys**, click **Create key**, give it a name like "Print Advisor", and **copy** it. It starts with `sk-ant-`.
4. In the app: **Settings → Claude API key** → paste it → **Save**.

Your key is encrypted on your computer and only sent to Anthropic. Treat it like a password: don't share it or post it online.

**B. Free chatbot (copy and paste)**

In **Settings**, pick **Free chatbot**. When you ask for advice, the app shows a prompt: copy it into ChatGPT, Claude or Gemini in your browser, then copy the answer back into the app. Same result, just a little more clicking. (Color remix, the screenshot reader and photo search need an API key.)

---

## 3. Open a model

Drag a **`.3mf`** file onto the window, or click **Open 3MF**. Files from **MakerWorld**, **Printables** and **Snapmaker Orca** all work. Downloaded files are usually in your **Downloads** folder.

The model appears in the middle. **Drag** to turn it, **scroll** to zoom. Under it you'll see its size, how much of it overhangs, how much touches the bed, and more.

> Only have an `.stl` file? Open it in Snapmaker Orca, save it as a project (`.3mf`), then open that here.

---

## 4. Check the toolheads (colors)

On the left, **Toolheads and materials** lists T1 to T4: each toolhead prints one filament. Click **✎ Change toolheads** to unlock them, set each one to the **material** you'll load (PLA is the most common and easiest), click the **color dot** to match your spool, then click **✓ Done**. The toolheads stay locked otherwise because every change sets the whole project up again, which is slow on big models; while they're unlocked the 3D view recolors as you go and the project is set up only once, when you click Done (**Cancel** puts them back as they were). If you go straight to recommendations, Save or Send while they're unlocked, your changes are applied first.

**See how the filament will look:** the button next to each toolhead's color picks its **finish** for the 3D view: Normal, Galaxy / glitter (sparkly flakes), Silk (glossy, pearly sheen), Matte (flat, no shine), Translucent (see-through), Glow in the dark or Chrome (a mirror finish, the most reflective). It's guessed from the filament's name (e.g. "PLA Silk"), and you can change it. Click **⟳ Spin** above the 3D view to turn the model slowly under the lights, from different angles, so you see how each finish catches the light (drag the view to stop). With a glow-in-the-dark toolhead, **☾ Lights off** darkens the room so you can see it glow.

**Abrasive filament:** carbon fiber (CF), glass fiber (GF), glow in the dark and metal- or stone-filled filament wear out a standard brass or stainless nozzle quickly. The app warns you under the toolheads and before printing: fit a **hardened steel nozzle** on that toolhead first. It also notes special handling for wood-filled, flexible (TPU), nylon/PC and ABS/ASA filament.

**See it in place:** the 🏠 picker at the bottom of the 3D view puts the model in a setting at its true size: a garden table, a bedroom wall shelf, a fireplace mantel, the front porch by the door, a Thanksgiving table, Christmas, a desk, a kitchen counter, Halloween or a kids' room shelf. Drag to turn the model (the setting stays put), scroll to zoom, and pick **Day, Evening or Night** (at night the room's own lights come on and glow-in-the-dark filament glows). **True size** shows it at its real size; click it for **Fill the view**. The **Photos** group has 8 real photo settings (Christmas, dining tables, wall shelves, winter snow, a marble kitchen counter): the model stands on the table or shelf; **⇲ Adjust** changes its size, where it stands (left / right, back / front) and the brightness of the photo and of the model (**Accent lights** dims or turns off the room's own lamps, candles and under-cabinet lights; in a photo, the lights in the picture, which keep shining at night; and **Glow intensity** when a filament is glow in the dark; at **Night** it glows, with its light on the table). **My photo → Add a photo…** uses your own photo as the backdrop (sliders set the model's size and place). **📷 Save picture** saves the view as an image.

If the model needs colors you don't own, a **"What to buy"** box appears with the closest colors you do have, and shop links.

---

## 5. Place it on the bed (orientation)

How a model sits on the bed changes everything. Parts printed over thin air (**overhangs**) droop unless the slicer adds **supports**.

1. Click **Overhangs** above the model. **Red** areas would print over thin air.
2. Look at the **Orientation** list. Each option shows its overhang area, how much touches the bed and its height. **"lowest risk"** is the app's pick.
   Each option also has a **Look** line: whether the top and sides people see print smooth, as designed, or how much of
   them would be printed on supports (rough, with support marks). The app takes the way the file is placed as the
   way the model is displayed, and never picks flipping a figure or statue upside down just to save support
   underneath: the hidden underside can take supports, the visible top shouldn't.
3. Click an option to try it. The model turns in the 3D view.

| Before: saved lying down, lots of red | After: "Stood upright · lowest risk" |
|---|---|
| ![](images/01-saved-lying-overhangs.jpg) | ![](images/02-stood-upright.jpg) |

---

## 6. Choose quality or speed

Under **What matters more?**, slide toward **Quality** (smoother surfaces, slower) or **Speed** (faster, visible lines). The middle is a good everyday choice.

Optionally, tell the app **what the part is for** ("a toy for my kid", "holds weight", "display piece"). The advice takes it into account.

If the parts snap or glue together, tick **These parts fit together** so the app keeps the designer's sizes exactly.

**Clean-release supports** (PLA or PETG models): tick it to print the support interface, the layers that touch the
model, in the opposite material: PETG under a PLA model, or PLA under a PETG model. The two don't stick to each
other, so the supports lift off and the underside comes out almost as smooth as a top surface. Load the other
material in a free toolhead first; the box explains what's missing until then. Because the model can't grip that
roof either, the app sets the supports up for it, whatever the AI suggests:
- no gap between roof and model (top and bottom Z distance 0) and a solid, interlaced roof of 3 layers;
- normal grid supports, not tree supports (tree tips are small and the model could slide off them), reaching 1.5 mm
  past each overhang, with a denser body so the roof doesn't sag;
- support for overhangs up to 40° from flat, so large, gently sloping overhangs rest on the clean roof too;
- the support body in the model's own material (only the contact layers use the other one), and the prime tower on.

It costs some tool changes and a prime tower, so it's slower and uses a bit more filament.

---

## 7. Get recommended settings

Click **Get recommended settings**. The app slices the model to measure it, then asks the AI. It usually takes under a minute.

You get a list of changes. Each row says **what changes**, **from what to what**, and **why**, in plain words. Untick anything you don't want.

![Recommendations](images/03-recommendations.jpg)

**Safety checks** at the top catch settings that wouldn't work and fix many automatically.

---

### Files with several plates or several different objects
- **One plate's recommendations** only change the objects on that plate when you save; the other plates keep their settings. A few settings can't be set per object in Orca (filament temperatures, first-layer height, prime tower); those apply to the whole file, and the app tells you.
- **Analyze all objects (N)** (under Get recommended settings) asks the AI about every *different* object on its own: copies and near-identical objects are analyzed once and get the same settings. It first shows how many requests that is and roughly what it costs. Afterwards, click an object to see and edit its settings. Settings that must be the same for a whole plate are listed once; if objects disagree, pick the value. **Save as 3MF** saves every object's settings in one file (in Orca you'll see them on each object: right-click → its settings).

## 8. Compare versions

Open the **Compare slices** tab, tick the versions you want (Original, Recommended, Finest, Fine, Fast, Fastest), and click **Slice and compare**.

You'll see each version's **look** (smooth or visible lines), **strength**, **print time** and **filament**. Click a version to read what you'll get.

![Compare slices](images/04-compare-slices.jpg)

---

## 9. Save it or print it

With a version picked:

- **Save as 3MF**: saves the model with these settings built in. Double-click the file to open it in Snapmaker Orca, check the preview, and print from there.
- **Send to printer…**: uploads straight to one of your printers. The **Preview** shows the sliced print in 3D (tick features on and off, slide through the layers). The app checks the print file first, as Orca does: anything that would leave the bed, be too tall or otherwise stop the printer blocks Print (a print that just pokes past the bed edge is moved back on automatically). **Settings in this print** lists every changed setting, read back from the sliced file that will be sent (✓ when it's really in the print; the layer height is also measured from the toolpaths), plus the print's main settings. Pick the printer, check which spool goes in which toolhead, and click **Print**.
- **Open in slicer**: opens it in Snapmaker Orca right away.

![Send to printer](images/05-send-to-printer.jpg)

---

## 10. Color remix

Turn a model into new color schemes using **only the filament you own**. There are two ways.

**Swap colors (the quick way, opens first).** The model keeps its painting exactly as it is; each of its colors just gets a different filament from your library. Works on any multi-color model, no parts to find.

1. Click **Color remix…**. Each of the model's colors is listed with how much of the model it covers.
2. Pick a new filament for any color, or click **Closest match** (the filament you own that looks most like each color) or **Shuffle** (a random scheme where light colors stay light and dark ones dark, so eyes and details still stand out). The 3D view shows it as you go. Both are free.
3. Optional: pick styles and click **Suggest schemes** to have the AI design a few (a few cents), then click one to try it.
4. Click **Apply to model**: the toolheads are set to those filaments. Color mixes change with them.

**Recolor by parts (the AI finds the parts).** Use this to color parts differently from how the model was painted, or a model with only one color.

1. Click **Color remix…**, then **Parts** at the top.
2. **Identify parts with AI**: the AI groups the model into parts (body, fins, windows…). Check them by turning the model. Fix a wrong spot by picking the part in the list and clicking or brushing over it.
3. Click **Confirm parts →**.
4. Pick **styles** (Realistic, Fun, Galaxy, Pastel…) and how many of each, then **Generate**.
5. Click a scheme to see it bigger, then **Apply to model**. The colors are painted in and the toolheads are set to your spools.

![Color schemes](images/07-remix-schemes.jpg)

Changed your mind? Open Color remix again and click **Undo remix** (it undoes a swap too).

---

## 11. Your filament library

Click **Filament** (top right). Click **Back to model** to return.

- **Inventory**: every filament you own, grouped by type and color, with photos. Click one for its spools, print settings and history.
- **Spools**: a table of every spool: sealed, opened, loaded in a printer, empty.
- **Dashboard**: totals, average cost per roll, what's running low, what's cheaper now than you paid, what's loaded in each printer, and **when you last added spools**: the **Last added from an order** tile (spools added from a screenshot of an order or from imported orders, with the newest order date) and the **Last spool added by hand** tile (+, Add filament, Add a spool, scanning a tag). Click a tile to see which spools were added, by day. If your newest Amazon order is later than the newest order date shown, that order hasn't been added yet.
- **Settings**: your storage places (shelves, dry boxes, printer slots), empty-spool weights for weighing, labels and backups, and whether spool tags are on.

**Adding filament**

- **+ Add filament**: type the brand, color, material and number of spools.
- **📷 From screenshot**: take a screenshot of your **order page** (Amazon or any store), a receipt or a product page, and drop or paste it (Ctrl+V) into the app. Claude reads it and lists the filament for you to check before adding. Product photos are cut from the screenshot; **Find missing photos online** looks up the brand's own store for the rest.
- **🛒 From Amazon**: reads your Amazon order history and adds the filament you bought. Pick your Amazon store and the years to read (or **Only orders since my last import**), then **Read my orders**. Amazon opens in the app's own window: sign in there yourself (the app never sees or keeps your password; **Sign out of Amazon** makes it forget the sign-in). The app only reads your orders, one page at a time; it never buys, cancels or changes anything. **Show the Amazon window** lets you watch, **Cancel** stops. With your Anthropic API key, Claude reads each filament product's title and picture (a few cents) for the brand, line, color, spool size and number of spools, including each color of a multi-color pack; without a key you get the titles, prices and pictures and fill in the colors. You check the list before anything is added: orders not delivered yet are **On order**, and ones already in your inventory are unticked.
- **Daily Amazon check** (Settings → **Filament** → **Amazon filament orders**, off until you turn it on): pick your store and a time. Once a day (and right after the app starts if it wasn't running then; it also works while the app is in the tray) it reads only the orders newer than the last one it checked. When it finds a new filament order you get a Windows notice and a badge on **Filament**; click either, check the list (Claude has already read it), and **Add checked filament**, or **Not filament: dismiss**, or **Later**. Spools you added as **On order** from Amazon are marked in stock (sealed) when Amazon says they were delivered. **Sign in to Amazon…** opens the window to sign in; **Check now** checks right away. If Amazon asks you to sign in again, the check tells you (a notice, and the line under the settings) instead of opening a window.

- **Scan a spool's tag**: see below.

**Scanning spool tags (NFC/RFID)**

Many spools have a small tag inside: Bambu Lab, Snapmaker, Creality, QIDI, Anycubic and ELEGOO, plus the open OpenSpool, OpenTag3D, SpoolEase and TigerTag formats. With an NFC reader you can tap a spool on it instead of searching the list.

1. Plug in a reader:
   - a **USB NFC reader**: any "PC/SC" smart-card reader that reads MIFARE Classic and NTAG (for example an ACR122U, ACR1252U, Cryptnox, HID Omnikey or Identiv reader). Windows needs no driver for most of them.
   - or an **Arduino with a PN532 NFC shield** (I2C): upload `tools/arduino/SpoolTagBridge` to it once with the Arduino IDE (see the [README there](../tools/arduino/SpoolTagBridge/README.md)).
   - or a **PN532 board** on a USB-serial adapter, with its switches set to HSU (UART).
2. Open **Settings** (the gear) → **Spool tags (NFC)** and tick **Scan spool tags with an NFC reader**. USB readers are found by themselves; an Arduino too (**Find an Arduino automatically**). For a PN532 board, pick its COM port. **Test** checks a board is answering. Click **Save settings**: the status line says **Ready** with your reader's name.
3. Tap a spool on the reader (hold it still for a second or two). Bambu Lab spools have a tag on each side; either works.

- **A spool you've scanned before** opens straight away, highlighted, so you can mark it opened, load it into a toolhead, weigh it or mark it empty.
- **A new tag** opens **New spool tag**, filled in from the tag (brand, material, color, weight, temperatures). If you already have that filament, **Add spool** adds one more. You can also **link the tag to a spool you already have** (one you added from an order or a screenshot), or add it as a new filament: tags don't carry a color name, so type one.
- **A spool without a tag**: write it to a blank NFC sticker (below), or just stick one on, scan it and link it to the spool. From then on it opens like any other.
- A spool's tags are listed in its history (**⋯**), with **Unlink** if you move a sticker.

Scanning works anywhere in the app: a scan opens the Filament screen. To only use scans while the Filament screen is open, untick **Scanning a tag on another screen opens the Filament screen** in Settings. Prusa's OpenPrintTag uses a different kind of tag (ISO 15693) that most of these readers can't read.

**Writing your filament to an NFC sticker**

Give any spool a tag that also tells other tools what's on it:

1. Open the filament and click **🏷 Write NFC tag** (or **🏷** on one spool's row). The panel shows what will be written: brand, material, finish, color, nozzle and bed temperatures, weight. It needs the nozzle temperature: if the card has none, type it in **Nozzle °C**.
2. Click **Write tag** and hold a **blank NTAG215 or NTAG216 sticker** on the reader. The app writes it, reads it back to check, and links it to that spool.

- The format is **OpenSpool** (read by the most tools and printer add-ons), or **OpenTag3D** (more detail, including the color name), chosen in **Settings → Spool tags**.
- **NTAG203 and NTAG213 stickers** hold only 144 bytes, too little for either format. The app offers **Link it without writing**: scanning it then opens the spool in this app, but other tools won't know what it is.
- A sticker that already has data on it asks before it's written over (you can turn that off in Settings). Bambu Lab, Snapmaker, Creality and QIDI tags (MIFARE Classic) are never written, and neither are a sticker's ID, lock, configuration or password pages, so a sticker can't be locked by accident.

**Your filament on your phone**

Open your filament library on your phone (iPhone or Android) while you're at home, in the phone's web browser:

1. On the PC: **Settings → Phone access**, tick **Open my filament library on phones on my home Wi-Fi**, and **Save settings**. If Windows asks whether to allow the app on networks, allow **Private** networks.
2. Open Settings again and click **Pair a phone**. Scan the QR code with the phone's camera and open the link (the phone must be on the same Wi-Fi). The code works once, for five minutes.
3. On the phone, **add the page to the Home Screen** (iPhone: Share → Add to Home Screen; Android: ⋮ → Add to Home screen) to open it like an app.

On the phone you can search and browse, update spools (open, empty, move to a dry box or toolhead, weigh, log grams used) and add filament, including from a photo of an order (Claude reads it with the API key on your PC). Changes appear on the PC and other phones at once. It works while the PC is on and the app is open; **Remove** a phone in Settings to lock it out.

- **Labels**: with phone access on, printed spool labels get a QR code. Point the phone's camera at it and the spool opens.
- **Stickers**: stickers the app writes link to their spool, so tapping one with the phone opens it (iPhone XS or newer, or Android with NFC on). Small NTAG203/213 stickers get just the link.
- **The PC's reader**: a scan on the PC's NFC reader also opens the spool on the phone (switch it off in Settings).
- **Secure address** (optional): for scanning inside the phone page (camera, and NFC stickers on Android Chrome). Turn it on in Settings, then pair the phone: the pairing page has you download and install the app's certificate first (also under **⚙** on the phone page, and as a QR code in **Settings → Phone access → Get the certificate on a phone**). On Android, close Chrome completely after installing it. While the page is open on the secure address it reads stickers itself (allow it once), so Android's own "New tag scanned" screen stays away. The camera app works for labels without any of this.
- Links use the PC's name (like `mypc.local`), which keeps working if the PC's address changes. Some Android phones can't find PCs by name: then they use the PC's address, labels and stickers link to the address too (Settings says so), and you should reserve that address for the PC in your router ("DHCP reservation") so it doesn't change.
- **Phone can't connect?** Windows may be blocking the app: Windows Security → Firewall & network protection → Allow an app through firewall → Change settings, and tick **Private** for AI 3D Print Advisor Studio.

![Filament library](images/09-filament-library.jpg)

Color remix and the "What to buy" box use what's in your library, so keeping it up to date pays off.

---

### Prices

Open a filament: **Prices** shows the **average per roll** (everything you paid ÷ the rolls with a price), the last and lowest price you paid, and a graph of each roll's price over time (blue dots; rolls bought together show "×5"), with a dashed line at your average.

- **Check prices now**: Claude searches the web for that exact product (brand, line, color, spool size) at Amazon, the brand's own store and other filament shops, using your API key (usually a few cents; the cost is shown). Each price says how much less or more it is than you last paid, sales and coupons are marked, and found prices are kept as orange diamonds on the graph. Always check the store before buying: prices change.
- **camelcamelcamel** and **Keepa** open Amazon's price history for the product you ordered (or a search, for filament you didn't buy on Amazon).
- The **Dashboard** lists filaments found cheaper than you last paid (checks from the last 30 days) and can check everything running low at once.

### Color gaps: which colors to buy next

The **Color gaps** tab looks at the colors you have **on hand** (filament with at least one spool left) and finds where they leave medium or large holes: colors nothing you own comes close to. Pick the **material** (gaps are found per material: a red PETG doesn't fill a gap in your PLA) and tick the **finishes** to include (Matte, Silk, Galaxy, Gradient, Color Change and so on): only those count as owned, and only those are searched for. Gradient and multicolor spools count each of their colors.

The gaps are ranked by **how much of the missing color range** each one would fill, with its size (medium or large) and the closest color you already have. Finding them is free and works offline. Each pick takes the ones before it into account, so the list doesn't suggest three nearly identical greens.

**Find products for the top 10** has Claude search Amazon first, then the makers' own stores and other filament shops, for real 1.75 mm spools in those colors, using your API key (the estimated cost is shown on the button's line; the real cost after). The app then **opens every link itself**: products whose page is gone are left out, the rest say **✓ Link checked** (or **Link not checked** when the store blocks automatic checks). Each product shows its price as seen during the search, the store, how close its color is, and its **photo**: click the photo to enlarge it. The last report is kept, so reopening the tab costs nothing. Prices change; check the store before buying.

### Print report

On the **Print history** tab, **📊 Stats…** opens a window with how your prints went on all your printers: the share that completed, were cancelled or failed; hours of successful printing and hours wasted; filament used and wasted, and what the waste cost (at $15 per 1 kg spool, or your own price); each printer’s rates (a printer with clearly more problems than the others is flagged); a timeline of every print from start to finish, colored by how it ended; and a chart per printer of completed, cancelled and failed prints over time. Pick the period, how much history to read, and metric or imperial units; hover the charts for details.

The dropdown above the list shows only **Completed**, **Cancelled**, **Failed** or **Printing now** prints, and the search box finds prints by name (for example “deer”); the count beside it says how many match. **📄 Report…** opens a report you can print or save as a PDF, for example to go with gifts or to keep a record.

- Choose the prints with **From / To**, **Printer**, **Name contains** and the **Status** boxes, and untick any print in the list to leave it out. Your choices and the title are remembered.
- **Summary**: totals (prints, printing time, filament in metres and kilograms), how far all that filament would stretch laid end to end, and a row per print with its picture, status, print time and planned time, filament used, colors, and a fun comparison like the Print Monitor's (“≈ the length of a school bus!”).
- **Detailed (with settings)**: adds a page or two per print with the settings it really used: profiles, filament per toolhead with weight, length and cost, then Quality, Strength, Speed, Support and adhesion, Multi-material, and Temperatures and cooling. Settings the advisor changed are marked **advisor**. These come from the end of the print's G-code on the printer (read-only), so the G-code must still be on the printer. They're the whole plate's settings: changes made to single objects in Orca aren't listed separately.
- **🧩 Multi-plate print? Combine prints…** on the certificate page: for a model printed in several prints (plates), tick the other prints that are part of it (prints with a similar name are listed first, then others finished within a week of this print or of any you have ticked, so a project printed over weeks can be gathered; **Find a print by name** searches them all). Their printing time, filament, colors, materials and printers are added to the certificate; the height shows the tallest piece, and strength is shown only when all the prints used the same settings.
- **🏅 Certificate…** (on each print in the report's list, and on each completed print in the **Print history** tab) makes a one-page certificate for that model, like a birth certificate, to go with a gift. Pick a template (**Fancy**, **Professional**, **Kids’ toy**, **Christmas gift**, **Mistletoe**, **Winter tree**, **Gingerbread**, **Wrapped presents**, **Reindeer**, **Snowman**, **Birthday gift** or **Rainbow**), give the model a name, fill in **To** and **From** (the labels change with the template, for example *Prepared for* on Professional), an optional message, and optionally the model’s **Weight** if you weighed it (just a number means grams; left empty, it isn’t shown). For the photo: **🖼 Choose a photo…** from this PC, **📱 Take one with your phone** (scan the QR code; take a photo or choose one already taken and it appears on the certificate a moment later; needs Settings → Phone access), or **📷 Printer camera photo** when the Print Monitor took its 99 % photo of that print. Without a photo the slicer’s picture is used. **🎨 Touch up / rotate photo** opens a preview with **Rotate** (⟲ ⟳) and **Straighten**, sliders (exposure, contrast, saturation, warmth, hue, sharpen), **✨ Auto-fix** to set them for you, **Hold to compare** with the original, and **Remove the background**: an AI model on your PC cuts the model out of the photo, and the certificate shows behind it (so it matches whichever template you pick). The first time, it asks to download the background remover (224 MB, once); after that it works offline and takes a few seconds. Your photo never leaves your PC. **Soften the edge** blurs the outline a little if you like. If bits of background are left (a reflection in a glass table, a shadow), fix them right there: **✨ Let Claude fix it** (with your API key, a few cents) has Claude mark the real object, trims the cut-out to it and checks the result (red boxes show anything still left); **➕ Add a missed piece** (drag a box around a piece that was left out, such as a base, a plaque or a separate part: it is added and nothing else changes; a certificate combining several prints keeps every piece the AI finds); **✂ Box around the model** (drag a box: everything outside goes); **🧽 Erase** and **🖌 Restore** brushes (paint on the picture; change the brush size with the slider); **↶ Undo** (Ctrl+Z) and **Start over**. The cut-out is trimmed to the model so it fills the frame (**Trim the empty space around the model**, with **Space around it** for more or less room; the dashed outline in the preview shows what is kept). Your original is kept, so you can touch it up again or **Undo touch up**. **✨ AI ideas** (needs your API key, a few cents each time, shown on the button) has Claude look at the model and suggest fun names and sayings (pick **Short**, **Medium** or **Long** next to the button; long ones read like a card message and can greet the person by name): click one to use it, or **More ideas** for new ones. **▾ Hide ideas** folds the list away. The frame takes the photo’s shape (wide for a landscape photo, tall for a portrait one), so the whole photo shows with no white bars. The certificate shows when the print was started and finished, how long it took, which printer made it, its height, layers, filament and colors. **🔤 Fonts and sizes** sets the font and size (in points, with a slider or by typing it; if there isn’t room, it stops at the largest size that fits and says so) of the title, the name, the message, the details, To and From, each on its own (**Use the template’s fonts** goes back). **🧵 List the filaments used…** picks the filaments the print(s) were made with from your filament library (the best matches for the print’s own filaments are suggested, **Add the best match for each** adds them all; search the library by any words, such as *matte beige*, or type one that isn’t in it; **💧 Pick a color on the photo** and click a part of the photo, with a magnifier to aim, to list your filaments closest to that color, handy when a part was sliced in one color and printed in another); they are listed under the photo as **Filaments used**. Under **Colors**, click a color to change it, **×** removes one the print didn't really use, **+ Add** adds one, **💧 From the photo** adds a color picked from the photo, and **Use the print's colors** goes back. Nothing is ever cut off: a long message, name or To / From wraps onto more lines, and the type gets smaller (and the photo narrower) if the page gets full. Everything is kept for next time. **🖨 Print…** opens it in your PDF viewer with a print preview (print from there with Ctrl+P, in landscape), or **Save as PDF…**. Touch up opens again where you left off (your cut-out and fixes are kept).
- **🖨 Print…** opens the system print dialog; **Save as PDF…** asks where to save. Prints still running show their planned amounts, because the printer only records time and filament when a print ends.

**Where a cancelled or failed print stopped.** In the **Print history** tab, each cancelled or failed print shows the layer it stopped on and its height, and the height to cut at to print just the rest: in Snapmaker Orca, select the model, press **C** (Cut), paste the height (**📋 Copy** copies it) and print the top part, then glue it on. The cut height is the top of the last whole layer; the half-printed layer on the bottom part is easy to sand flat. If the print failed well before it stopped (spaghetti, a layer shift), cut lower. When the Print Monitor was watching, the layer is exactly what the printer reported; otherwise it is worked out from the filament the print used and its G-code on the printer (usually within a few layers, so check the part). If the G-code has been deleted or replaced on the printer since, the layer can't be worked out. With a raft, the height includes the raft.

**✂ Print the rest…** does the cutting for you: check the **Cut at** height (it starts at the top of the last whole layer), click the button, and choose the project (.3mf) the print came from (and which plate, if it has several). Every object on that plate is cut at that height, closed flat at the cut and lowered onto the bed, and saved as a new 3MF next to your project (named “… - rest from 126.08 mm.3mf”; your project isn't changed). Objects that had already finished are kept but turned off, and parts that were entirely below the cut are taken out. Your settings, per-object settings, filament per part and painted colors stay. Then **Open in Snapmaker Orca**, check it, slice and print, and glue the top on. Variable layer heights are taken out of the copy (they were set for the whole model). When the Print Monitor was watching as the print stopped, it kept exactly where the printer was in the file and the nozzle's height, so the layer and the cut height are exact.

## 12. When a print fails: the troubleshooter

1. Open the **Print history** tab (your printers must be added in Settings).
2. Next to the failed print, click **Troubleshoot…**.
3. **Paint where it failed** on the model, pick what went wrong (spaghetti, warping, stringing…), and add a sentence if you like. A photo helps too (up to 4).
4. Run it. You get the likely causes, most likely first, and the settings to change.
5. Tick the fixes you want (you can edit the new values) and click **🖨 Print fixed version…** to print it right away with every fix, or **💾 Save fixed 3MF…** to keep a file.
   Reopening the print later shows the same diagnosis (no new AI cost); click **Run a new diagnosis with Claude** only if you want a fresh one. If you click **Use these settings** and then Get new recommendations, the troubleshooter's fixes are kept and the new advice is added. For the file: If the app doesn't have the model for that print, it asks for the project file (.3mf) you sliced in Orca. It saves a copy with the fixes built in (the original stays as it was); double-click it to open it in Snapmaker Orca, check the preview, and print. (**Use these settings** instead opens the model in the main window with the fixes, to compare slices or send it to a printer.)

**Photos from your phone.** Click **📱 Take photos with your phone** under Photos and scan the QR code with your phone's camera (phone access must be on: **Settings → Phone access**). The phone opens a page with a big **📷 Take a photo** button; each photo you take shows up in the troubleshooter a moment later. Photos you already took: **🖼 Choose from your photos** (the gallery) or **📁 Browse the phone's files** (Downloads and other folders); pick several at once. (HEIC photos can't be opened in the browser: use the 📷 button, or set the camera to JPEG.) The first time, the phone asks to pair with your PC: tap **Pair this phone**. You can also take the photos first, at the printer: on a paired phone, tap **📷** on the Filament page. Photos from the last 2 hours go into the troubleshooter by themselves when you open it; older ones wait under **Photos**, one click away. Remove a photo with its **✕**, on the phone or the PC.

![Troubleshooter](images/13-troubleshooter.jpg)

Also rate your prints (**Good / Had issues / Failed**): future recommendations learn from them.

---

## 13. Models from MakerWorld (Bambu Lab files)

Most MakerWorld models are saved for Bambu Lab printers, which is why Snapmaker Orca often shows warnings when you open them. Open them in this app instead: it **converts them for the Snapmaker U1** automatically, keeps the designer's important settings (walls, infill, supports), and tells you what it changed.

![A MakerWorld file converted for the U1](images/14-makerworld-converted.jpg)

Own a Bambu Lab printer? You can open MakerWorld files as they are. The app can also **export a Bambu Studio project** of your tuned model, ready to share on MakerWorld.

---

## Why a print can still fail

The app chooses good settings, but a lot of what decides a print happens outside it. So even the best settings can't promise a perfect print. **Good to know**, under every set of recommendations and every troubleshooter result, lists these:

- **Damp filament.** Most filament soaks up moisture from the air (PETG, TPU and nylon most). Wet filament strings, pops, looks rough and prints weak. Dry it (a filament dryer, or your printer's drying function), and store it sealed with desiccant.
- **The room.** Cold rooms, drafts (fans, windows, air vents) and temperature swings cause warping, cracks and prints coming loose. ABS and ASA need an enclosure.
- **The filament itself.** Brands and even colors of the same material print differently. Check the temperatures on the spool's label.
- **The printer.** A dirty or uneven bed, a worn or partly clogged nozzle, loose belts or skipped calibration cause failures no setting fixes. Clean the bed (dish soap and water, or isopropyl alcohol) and run the printer's calibration now and then.
- **The model.** Very thin walls, a tiny footprint on the bed or a broken mesh can fail whatever the settings.

**AI can make mistakes**, especially with little to go on. Tell it what the part is for, describe problems in the troubleshooter and add photos. The app's safety checks catch settings that wouldn't work, but read each change before printing, and do a small test print when it matters.

The printable cheat sheets (below) have this too, so you can keep it next to your printer.

## Printable cheat sheets

Two PDFs (US Letter) to print or keep open: a **1-page quick sheet** (the steps, buttons, common problems, key words) and a **booklet** (setup, why prints fail, a troubleshooting table, and every word with its picture). Open them from the **Glossary** window or **Settings** in the app, from the **Printable cheat sheets** folder next to the program, or here: [1-page](cheat-sheets/AI-3D-Print-Advisor-Cheat-Sheet-1-page.pdf) · [booklet](cheat-sheets/AI-3D-Print-Advisor-Booklet.pdf).

## 14. Keeping an eye on AI costs

The **AI** button at the top shows what the app's AI requests cost this month. It briefly shows the cost of each request as it happens (like "+8¢"). Click it, or open **Settings → AI spending**, for a breakdown by feature.

To see what your API key has cost **in total** (including use outside this app), open your [API keys page](https://platform.claude.com/settings/keys) in the Claude Console. Settings → AI spending links there too.

---

## 15. Watching your prints: the Print Monitor

Add your printers in **Settings → Printers** (the address you'd type to open Fluidd or Mainsail, and for a Snapmaker U1 its API key, from the printer's screen). The app then watches them while it's running:

- **The bar on the main screen** shows each printer: a thumbnail of the print, how far along it is, the time left and when it ends. Click one to open it in the Print Monitor.
- **Print Monitor** (top bar, or the bar's button) shows every printer side by side with its camera, and a full page per printer: the live camera; the slicer's picture, the whole model from another angle and the model filling in layer by layer; progress and layers; when it started, the time printed, the time left, the estimated duration and when it ends; each toolhead's temperature and filament color (the one printing is marked ACTIVE); bed, enclosure, fans and speed; the filament used compared with everyday things; and the printer's lifetime totals.
- **Pause, Resume and Cancel** each ask first, and nothing is sent unless you click the box's Pause, Resume or Cancel button (Esc or "Keep going" sends nothing). The app never pauses, resumes or cancels a print on its own. Cancel can't be undone. If a print pauses and this app didn't do it, the alert says "not by this app".
- **Timelapses** plays and downloads the printer's timelapse videos. **Final photos** keeps a photo of every print, taken at 99 % (before the bed drops) on your PC.
- **Time left** is the slicer's plan scaled to how fast this print is really going (like Home Assistant's and Mainsail's "Print ETA"), so it stays right when a print runs slower or faster than the slicer guessed. While the printer is heating, the slicer's estimate is shown.

**Alerts** (Settings → Print monitor): tick which events go where:

- **Windows** notifications: print started, paused, error, cancelled, finished, and done and cooled (ready to remove, with the final photo).
- **Phone (ntfy)**: install the free [ntfy](https://ntfy.sh) app, click **New** for a topic nobody could guess, subscribe to the same topic in the app.
- **Email**: your mail server (for Gmail `smtp.gmail.com`, port 587, STARTTLS, and an **app password**). Progress emails come with a camera photo and the printer's numbers at the steps you tick (1 / 25 / 50 / 75 %), and the "done" email has the final photo. **Send a test alert** checks it.

**Bigger or smaller**: drag the bottom edge of the printer bar to change its height; everything in it scales along (double-click the edge for the normal size). To make the whole app bigger for reading, use **Settings → General → Text and screen size**, or **Ctrl +** / **Ctrl −** / **Ctrl 0** (or Ctrl + mouse wheel). Windows open on the monitor, place and size you last used.

**Keep watching**: closing the window keeps the app in the tray (by the clock) so alerts and the final photo still happen; right-click the tray icon to quit. **Start with Windows** opens it in the tray when you sign in. Untick either in Settings → Print monitor.

**Cameras**: a Snapmaker U1's built-in camera needs the printer's API key (the app keeps it awake while you watch or print). For other printers pick a webcam snapshot or MJPEG address in Settings → Printers, or No camera.

**On your phone**: with Phone access on, the phone page has **🖨 Printers**: the same Print Monitor.

**Coming from U1 Studio?** Settings → Print monitor → **Bring over settings and photos from U1 Studio** (pick its `data` folder), then stop U1 Studio from starting with Windows so you don't get every alert twice.

## Words you don't know

New to 3D printing? Words like **brim**, **infill** or **prime tower** have a **dotted underline** in the app.

- **Hover** the mouse over an underlined word: a small window explains it in plain words, with a drawing.
- **Click** the word to keep the explanation open while you read; click anywhere else to close it.
- Click **All words** in that window, or the **Glossary** button at the top of the app, to see every word with its drawing. Type in the search box to find one.

The underlines are on when you chose "Brand new" or "A little". To turn them on or off: **Settings** (gear, top right) → **Explain 3D printing words**.

![An underlined word explained with a drawing](images/16-word-help.jpg)

## Glossary

| Word | What it means |
|---|---|
| **3MF** | A 3D model file that can also hold colors and print settings. The usual download format on MakerWorld. |
| **Slicer** | The program that turns a 3D model into instructions for the printer (Snapmaker Orca, Bambu Studio, OrcaSlicer). |
| **Slicing** | Cutting the model into layers and planning the nozzle's path. Gives the real print time and filament use. |
| **G-code** | The finished instructions file the printer runs. |
| **Toolhead (T1–T4)** | A print head with its own filament. The U1 has four, so it can print four colors. |
| **Filament** | The plastic "string" on a spool that the printer melts. **PLA** is the easiest; **PETG** is tougher; **TPU** is flexible. |
| **Overhang** | A part of the model printed over thin air. Up to about 45° is usually fine; steeper droops. |
| **Supports** | Throwaway scaffolding the slicer adds under overhangs. You break it off after printing. |
| **Orientation** | How the model sits on the bed. The right one avoids supports and prints stronger. |
| **Layer height** | How thick each layer is. Thinner (0.08–0.12 mm) = smoother but slower; thicker (0.24–0.28 mm) = faster, visible lines. |
| **Walls** | The solid outer shell, counted in lines. More walls = stronger. |
| **Infill** | The pattern inside the model. 10–20% is typical; more is stronger and heavier. |
| **Brim** | A thin flat ring printed around the bottom to help a model stick to the bed. Peels off afterwards. |
| **Prime tower** | A small tower printed beside the model to clean the nozzle when switching colors. |
| **API key** | A secret code that lets the app use Claude, billed to your Anthropic account. |
