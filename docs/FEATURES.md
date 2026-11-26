# Features

Everything AI 3D Print Advisor Studio can do, in one list. New to 3D printing? Start with the [user guide](USER-GUIDE.md); words like "overhang" are explained in its [glossary](USER-GUIDE.md#glossary).

## Check a model before printing

- **3D preview**: turn and zoom the model, see it in its filament colors.
- **Filament finishes**: silk, matte, translucent, glow in the dark, chrome and galaxy looks, with ⟳ Spin and ☾ Lights off.
- **See it in place**: the model at true size in 10 built settings (garden, shelf, mantel, porch, Thanksgiving, Christmas, desk, kitchen, Halloween, kids' room) with day / evening / night lighting, 8 real photo settings, or your own photo; 📷 save a picture.
- **Overhang view**: red where the model would print over thin air, orange where it's borderline.
- **Measurements**: size in mm and inches, volume, overhang area, how much touches the bed, how stable it is, number of colors, flat tops.
- **Orientation finder**: scores every way to place the model and marks the **lowest risk** one. Click to try each.
  Each option says what it does to the look (the visible top and sides printed smooth, or on supports), and the pick
  keeps a display piece's top off supports instead of flipping it to save support underneath.
- **Safety checks**: catches settings that wouldn't work (temperatures, cooling, supports, flow) and fixes many automatically.
- **Heavy-model fix**: very detailed models that would slice slowly can be simplified with one click (undoable).
- **"These parts fit together"**: keeps sizes exactly as designed for snap-fit and multi-part models.
- **Clean-release supports**: the support interface in the opposite material (PETG under PLA, PLA under PETG), with
  supports set up for it (no gap, solid interlaced roofs, wide normal supports, prime tower) so undersides come out
  almost flawless.

## AI recommendations

- **Get recommended settings**: Claude looks at the model, a real slice, your printer, your past prints and what the part is for, then lists what to change, with a plain-English reason for each.
- **Quality ↔ Speed slider** with ready-made "recipes" from fine to fastest.
- Untick any change; **copy a checklist**; **save as Orca presets** to reuse on other models.
- **Free chatbot mode**: no API key needed; copy and paste with ChatGPT, Claude or Gemini.
- **Choice of Claude model**: Sonnet (balanced), Opus (best), Haiku (cheapest), or any model ID.

## Compare versions

- Real slices of **Original, Recommended, Finest, Fine, Fast, Fastest**, side by side.
- For each: **how it looks**, **how strong**, **print time**, **filament**, layers, tool changes, peak flow.
- Warnings when a version takes much longer, with what causes it.

## Save and print

- **Save as 3MF** with the settings built in (opens straight in Snapmaker Orca).
- **Send to printer**: pick a Snapmaker U1 on your network, see what's loaded in each toolhead, map filaments, upload and start.
- **Open in slicer**: opens it in Snapmaker Orca; edits you save there come back to the app.
- **Save G-code** for a USB stick or Fluidd/Mainsail upload.
- **Export for Bambu Lab**: a Bambu Studio project of your tuned model, ready for MakerWorld.
- **Batch convert**: convert a whole folder of models for your printer.
- **Print names** that voice assistants read out nicely ("White Rocket").

## Color remix

- **Swap colors**: keep the model's painting and give each color another filament you own: by hand, **Closest match**, **Shuffle** (free), or schemes the AI suggests. Live 3D preview; color mixes follow.
- **Recolor by parts**: the AI finds a model's parts (body, eyes, fins…); you check and correct them by clicking or brushing.
- New **color schemes** in styles like Realistic, Fun, Galaxy, Color Shift, Pastel, Monochrome and Holiday, using **only filament you own**.
- Optional **extra colors** with a pause to swap spools mid-print.
- **Apply** paints the colors in and sets the toolheads; **Undo** puts it back.

## Filament library

- Every filament and spool you own, with **product photos**, color swatches, brand, material, finish and price.
- **Spool tracking**: sealed, opened, drying, loaded, empty; grams left; where it's stored; history.
- **Weigh-ins**: enter the scale reading, the app subtracts the empty spool.
- **Scan spool tags (NFC/RFID)**: tap a Bambu Lab, Snapmaker, Creality, QIDI, Anycubic or ELEGOO spool (or OpenSpool, OpenTag3D, SpoolEase, TigerTag) and that spool opens, or is added with its brand, material, color, weight and temperatures filled in from the tag. Works with USB NFC readers (ACR122U, ACR1252U, Cryptnox, HID Omnikey…), an Arduino with a PN532 shield, or a PN532 board.
- **On your phone** (iPhone and Android, home Wi-Fi): pair with a QR code, then look up, update and add filament from the phone's browser (Home Screen app). Changes sync live with the PC. Spool labels get a QR code that opens the spool; stickers the app writes open it with a tap; scans on the PC's reader show up on the phone. Optional secure address for scanning inside the page (camera; NFC on Android).
- **Write your own filament to NFC stickers** (OpenSpool or OpenTag3D on NTAG215/216), linked to the spool so scanning it opens that spool. Other tools that read OpenSpool understand it too. Brand tags are never written.
- **Add from a screenshot** of any order page, receipt or product page (read by Claude), with photos cut out automatically and **missing photos found online** from the brand's store.
- **Add from your Amazon orders**: reads your Amazon order history (22 stores; you sign in yourself in the app's own window, and it only reads) and lists the filament you bought, with each color of a multi-color pack read by Claude. An optional **daily check** finds new filament orders (a Windows notice and a badge; you confirm before anything is added) and marks spools on order as in stock when they're delivered.
- **Manufacturer print settings** and Snapmaker Orca presets for many brands.
- **Prices**: average cost per roll, a graph of what you paid for each roll, and **Check prices now** (Claude web search) for current prices and sales below what you last paid; camelcamelcamel and Keepa links for Amazon price history.
- **When you last added spools**: dashboard tiles for the last spools added from an order and by hand, with the list behind each.
- **Color gaps**: finds the medium and large holes in your on-hand colors (per material, filtered by finish), ranks the colors that would fill the most, and (Claude web search, Amazon first) finds products for the top 10 with checked links, prices and product photos.
- **Dashboard**: totals, value, average per roll, what's running low, what's cheaper now, what's loaded in each printer.
- **Labels** for spools (Avery sheet or label printer), **CSV export**, **backups** (daily automatic copies too).
- **What to buy**: when a model needs colors you don't own, the closest ones you have and shop links.

## Print Monitor

- **Every printer at a glance**: a bar on the main screen with each print's thumbnail, progress, time left and end time.
- **Print Monitor window**: live cameras, preview pictures drawn from the G-code (whole model and layer by layer), progress and layers, started / elapsed / time left / estimated duration / end time, toolheads with filament colors, bed, enclosure, fans, lifetime totals; pause / resume / cancel (confirmed); timelapse videos; a final photo of every print taken at 99 %.
- **Alerts**: Windows notifications, phone push (ntfy) and email (progress emails with a camera photo; a "ready to remove" email with the final photo once the bed has cooled).
- Any Klipper / Moonraker printer; Snapmaker U1 extras (built-in camera keep-alive, four toolheads, timelapses). Keeps watching from the tray; can start with Windows. On paired phones too. Replaces U1 Studio and the Home Assistant dashboard scripts.

## Print history and troubleshooting

- **Print history** from your printers; rate each print so future advice learns from it. Filter by status and search by name. Cancelled and failed prints show the layer and height they stopped at, and where to cut the model to print just the rest; **✂ Print the rest…** makes that cut for you (a new 3MF with the top part of every object on the plate, ready for Snapmaker Orca).
- **Print stats**: success rate, hours printed and wasted, filament used and wasted with its cost, each printer’s cancel and fail rate, a start-to-finish timeline of every print and each printer’s prints over time (metric or imperial).
- **Print report**: a summary of the prints you pick (status, time, filament, colors, pictures, “≈ a school bus” comparisons) or a detailed report with each print's settings (quality, strength, speed, support, multi-material, temperatures) read from its G-code; print it or save it as a PDF.
- **Print certificates**: a colorful one-page certificate for a single print to give with it (Fancy, Professional, Kids’ toy, Christmas gift, Mistletoe, Winter tree, Gingerbread, Wrapped presents, Reindeer, Snowman, Birthday gift or Rainbow), with a photo from the PC, your phone (QR code) or the printer camera (rotate and straighten it), the filaments used (from your filament library, or matched to a color picked on the photo with an eyedropper), a name, To and From, a message, its start and finish times and its stats. **AI ideas** suggests fun names and sayings for the model; **Touch up photo** adjusts exposure, contrast, colors and sharpness, removes the background with an AI model on your PC (a clean cut-out on the certificate), and has an Auto-fix, all with a live preview.
- **Settings per object**: multi-plate and multi-object files keep different settings for different objects in one 3MF (Orca's per-object settings). "Analyze all objects" gets AI advice for each different object (copies and near-identical ones once), shows the cost first, and merges everything into one file.
- **Troubleshooter**: paint where a print failed, pick the symptoms, add photos; the AI reads the printed G-code at that spot and gives likely causes and fixes. **Save fixed 3MF** saves a copy of the model with the chosen fixes built in, ready to print from Orca.
- **Photos straight from your phone**: scan the troubleshooter's QR code and take the pictures with your phone's camera; they appear in the troubleshooter by themselves over your home Wi-Fi (no cloud storage, no app).

## Costs, privacy and help

- **AI spending**: the cost of every AI request, this month's total in the top bar, details by feature in Settings, and a link to your API keys page in the Claude Console for the key's total cost.
- **Everything stays on your computer**; your API key is encrypted.
- **Step-by-step guide**, "?" tips, and an experience setting (from "brand new" to "expert").
- **3D printing words explained**: for beginners, words like brim, infill or purge are underlined; hover for a plain explanation with a drawing. The **Glossary** button lists about 50 words, searchable.
- **Sessions**: your work is saved as you go and comes back after a restart; export a session to share.
