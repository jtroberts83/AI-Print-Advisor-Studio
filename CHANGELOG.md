# Changelog

## 2.60.1
- **Fixed: very detailed models looked see-through in the 3D view** (speckled, like scattered dots, such as the
  Japandi Rentier with 3 million triangles). For models over 1.5 million triangles the view showed only every 2nd or
  3rd triangle, leaving holes. It now shows a smaller copy that merges points closer together than a tiny grid, so
  the surface stays solid and keeps its shape. Measurements, slicing and saving still use the full model.

## 2.60.0
- **Certificate: change the sentence under the name.** A new **Line** box in **Words** holds the words between the
  name and the date ("was crafted with holiday cheer and finished on"). Type your own, or leave it empty for the
  template's. Tick **Two or more** when the print is several things (two geckos, a set of ornaments): "was" becomes
  "were", "Its filament" becomes "Their filament", and the Kids' toy heading says "New friends have arrived!".
  Saved with the certificate.

## 2.59.2
- **Fixed: Snapmaker Orca could refuse to send a print** with "Processing of the filename_format template failed …
  Non-integer index is not allowed to address a vector variable". The app names the G-code after the saved file,
  but Snapmaker Orca only keeps the settings a project marks as changed and took its own name template instead
  (`{input_filename_base}_{filament_type[initial_tool]}_{print_time}.gcode`), which can fail. The name is now marked
  as changed, so Orca uses it (and keeps it when you save the project in Orca). Save or open the file from the app
  again to get the fix.

## 2.59.1
- The certificate page remembers its open sections in a simpler way (only their names). Nothing else changed.

## 2.59.0
- **Certificate: pick the words under the From name.** Next to From, choose the template's own words (such as
  *Created by*) or **Love**, **With love from**, **Love always**, **XOXO**, **Hugs and kisses**, **Your friend**,
  **Merry Christmas from**, **Your Secret Santa**, **Sincerely** and more, or **Your own words…** to type anything.
  Saved with the certificate.
- **The certificate page is tidier.** The options sit in a panel beside the certificate (above it in a narrow
  window), and the certificate grows to fill the rest of the window. The panel has sections: **Template**, **Words**
  (name, To, From, message, weight and AI ideas) and **Photo** are open. **Colors**, **Filaments used**, **Fonts and
  sizes** and **Multi-plate print** fold to one line with a summary (their colors, "7 listed", "Combined with 1
  other print") and open with a click. Which sections are open is remembered. Print and Save as PDF stay at the top.

## 2.58.0
- **Compare slices: the whole project's print time** for models with several plates. Optional: under the versions,
  pick **All N plates** instead of **Only this plate** (the default). Every version is sliced once per plate, so the
  app first says how many slices that is and roughly how long it will take (slices made before are instant), with
  **Start slicing**, **Only this plate** or **Cancel**. While it slices, a progress panel shows the overall bar, how
  far along it is, the time so far and about how long is left, what is slicing now, and a grid of every version and
  plate (each plate's print time as it finishes). **Cancel** stops right away (the running Snapmaker Orca processes
  are stopped too); versions with every plate sliced are kept. The results show each plate's print time and the whole
  project's, for every version, compared with the original; **Plate by plate** adds filament and layers, and
  **Send…** sends one plate (a printer prints one plate at a time). Save as 3MF saves every plate.

## 2.57.0
- **Picture for the saved file**: Save as 3MF and Export for Bambu Lab now ask which picture the file gets (the one
  Windows Explorer, the slicer's project list and MakerWorld show). The file's own thumbnail is picked by default,
  so it is kept; you can also choose its plate picture or photos, a picture of the app's 3D view, or **your own
  photo** (choose it or drop it on the window), shown whole or cropped to fill the square. The app makes the 512,
  256 and 128 px pictures and the plate picture a 3MF needs. The choice is kept for every save of that model (change
  it under **Pictures in this file**); Open in Snapmaker Orca uses it without asking.

## 2.56.0
- Filament, **🛒 From Amazon** and the daily check: an order you already added from a screenshot or by hand is now
  spotted too. When you have that filament (same brand, type and color) with spools bought from 3 days before the
  order to 3 weeks after it, the row comes in unticked as **Probably added already**, with how many spools you have
  from around then. Tick it to add it anyway. (Orders added with 🛒 From Amazon were already recognized exactly.)

## 2.55.0
- Filament, **🛒 From Amazon**: choose the exact dates the orders were placed (day, month and year, from … to)
  instead of whole years. Orders outside the dates are skipped without opening them, so a busy Amazon account with
  many non-filament orders reads much faster.

## 2.54.0
- Filament: new **🛒 From Amazon** adds the filament you bought on Amazon, from your order history. The app opens
  Amazon in its own window and you sign in there yourself: the app never sees or keeps your password, and it only
  reads your orders (it never buys, cancels or changes anything). Pick your Amazon store (22 countries) and the years
  to read, or only the orders since your last import. It finds the filament orders (skipping everything else), and
  Claude reads each product's title and picture for brand, line, color, spool size and how many spools (each color of
  a multi-color pack; a few cents, with your API key). You check the list before anything is added, as with
  screenshots. Orders not delivered yet are added as **On order**; ones already in your inventory are marked.
- New **daily Amazon check** (Settings → Filament → Amazon filament orders, off until you turn it on): once a day at
  the time you pick (and right after the app starts, if it missed that time) it reads only the orders newer than the
  last one it checked. A new filament order gets a Windows notice and a badge on **Filament**; Claude has already read
  it, and you add it or dismiss it. Spools on order from Amazon are switched to in stock (sealed) when Amazon says
  they were delivered. If Amazon wants you to sign in again, it tells you instead of opening a window.
- Built into the app; the approach follows the MIT-licensed amazon-order-history-csv-download-mcp project (credited in
  THIRD-PARTY-NOTICES.md), with no dependency on it.

## 2.53.0
- Certificates, **🧵 Filaments used**: **Find** in your filament library works. Its results were there but squeezed
  out of sight under the suggestions. It also finds by several words in any order (“matte beige”) and by color family.
- The suggested matches go by color first (compared the way eyes see color), and use the slicer's filament name
  (finish such as Silk or Wood, the same profile) and type to help. A “Generic PLA” filament no longer pulls the
  same few filaments to the top for every color, so a rope sliced in light beige now suggests your beige filaments.
- New **💧 Pick a color on the photo**: click a part of the certificate's photo (a magnifier shows the spot) to list
  the filaments in your library closest to it, for a part sliced in one color but printed in another.
- **Colors**: new **💧 From the photo** adds a color picked from the photo, the color as it really printed.

## 2.52.0
- Certificates, **Remove the background**: a model in several pieces (a plaque or base, a rope, separate parts) no
  longer loses pieces. The closer second look could drop whole pieces the first look found; now it only tidies the
  edges. When the certificate combines several prints, the AI keeps every piece it finds, and Claude's check is told
  the model is in several pieces.
- New **➕ Add a missed piece**: drag a box around a piece the cut-out left out; the AI looks inside the box and adds
  it, keeping everything else.
- **Rotate** (⟲ ⟳, a quarter turn) and **Straighten** (±15°) in Touch up (now **🎨 Touch up / rotate photo**).
- **🧵 Filaments used**: pick the filaments the print(s) were made with from your filament library (best matches for
  the print's own filaments are suggested; search the library, or type one that isn't in it). They are listed under
  the photo with their colors.

## 2.51.0
- Certificates: six new holiday templates, each with its own drawings, colors, wording and seal: **Mistletoe**,
  **Winter tree** (snowy Christmas trees), **Gingerbread** (gingerbread people), **Wrapped presents**, **Reindeer**
  and **Snowman**. ✨ AI ideas match the theme too.
- Certificates, **🔤 Fonts and sizes**: sizes are now in points (pt), as they print, with a slider and a box to type
  the size. Dragging a slider up never makes the text smaller any more (before, it could jump smaller, bigger and
  smaller again). When there isn't room for the size you pick, the text stops at the largest size that fits and the
  row says so ("fits at 54.5 pt").
- Certificates: To / From in a handwriting font were made smaller than needed (the font draws a little above its
  line, which was taken for text not fitting).

## 2.50.0
- Certificates, **✨ AI ideas**: choose how long the sayings are: **Short** (one line), **Medium** (two sentences)
  or **Long** (a card message of three or four sentences, which can greet the person by name: “Every dragon needs a
  best friend. Merry Christmas Harper, this one chose you. May it guard your shelf…”). The choice is remembered.

## 2.49.0
- Certificates, **🔤 Fonts and sizes**: **To** and **From** now have their own font and size (they shared one before;
  a setting made in 2.48 applies to both until you change one). The panel names them as the template does
  (“Presented to”, “Created by”…). The “(changed)” label and **Use the template's fonts** appear as soon as you
  change something.

## 2.48.0
- Certificates: **🔤 Fonts and sizes**. Pick the font and the size (50–200 % of the template's) for the title, the
  name, the message, the details and To / From, each on its own. Only fonts this PC has are listed. Kept with the
  certificate; **Use the template's fonts** goes back. If what you pick doesn't fit, it's made just small enough to
  fit (and says so), so nothing is cut off.
- Certificates: To and From (and other text) no longer come out too small when the window is small. The preview is
  scaled to the window, and the sizes were measured at that scale.

## 2.47.0
- Print history: **✂ Print the rest…** on a cancelled or failed print. Choose the project (.3mf) it was printed from
  (and the plate, if it has several): every object on that plate is cut at the height it stopped at (you can change
  it), closed flat at the cut and lowered onto the bed, in a new 3MF next to your project (the project itself isn't
  changed). Objects that had already finished are kept but turned off, and parts entirely below the cut are taken
  out. Your settings, per-object settings, filament per part and painted colors stay. Then open it in Snapmaker Orca,
  slice and print, and glue the top on. Variable layer heights and old sliced G-code in the project are taken out.
- **Exact stop point**: when the Print Monitor sees a print stop, it now also keeps where in the file the printer was
  and the nozzle's height, so the layer and the cut height are exact (not worked out from the filament). If the
  G-code is later deleted from the printer, the nozzle's height is still known.

## 2.46.0
- **Print history: where a cancelled or failed print stopped.** Each cancelled or failed print shows the layer it
  stopped on (“Stopped on layer 788 of 1124, 126.24 mm high”) and the height to cut the model at to print just the
  rest: the top of the last whole layer, with **📋 Copy** to paste it into Snapmaker Orca's Cut tool. When the Print
  Monitor was watching, the layer is the one the printer reported. Otherwise it's worked out from the filament the
  print used and its G-code on the printer (checked against running prints: within a few layers), read once and kept.
  A G-code since deleted or replaced under the same name is said so, instead of giving a wrong layer.
- Certificates: **change the colors** shown. Click a color to pick another, **×** to remove one the print didn't
  really use, **+ Add** for a missing one; **Use the print's colors** goes back. Kept with the certificate.
- Certificates: **nothing is cut off any more.** A long message wraps onto as many lines as it needs (it used to end
  with “…”), and so do long names and To / From. If the page gets full, the type gets smaller and the photo narrower
  until everything fits. The message box in the editor is several lines tall too.

## 2.45.1
- Certificates, **Combine prints**: for a long project printed over weeks, the list now shows prints finished within a
  week of **any** print you've ticked (it grows as you tick pieces), and **Find a print by name** searches all the
  completed prints read. Ticked prints always stay in the list so they can be unticked.

## 2.45.0
- Certificates for a model printed in **several prints (plates)**: **🧩 Multi-plate print? Combine prints…** lists the
  completed prints with a similar name first, then every other completed print finished within a week; tick the ones
  that belong to the model. The certificate then shows the earliest start and latest finish, the printing time and
  filament of all of them added up (“43 h 59 min across 4 prints”), every color, material and printer used, the
  layers printed, the layer height (or its range), “Made from: 4 prints”, and the **tallest piece** (heights aren't
  added: the pieces don't all stack). Strength is shown only when every print used the same walls and infill. When
  other prints have a similar name (or the file is named “…_plate_2”), the certificate page points it out. The choice
  is kept with the certificate.

## 2.44.0
- Certificates: **Touch up photo** opens again where you left off: the cut-out (with your box, Erase/Restore and
  Claude fixes) is kept with the photo, so changing a slider later doesn't run the background remover again. **Start
  over** still asks the AI fresh; **Undo touch up** brings back the original photo.
- **🖨 Print…** (certificate and print report) now opens the page as a PDF in your PDF viewer (usually Edge), which
  shows a real print preview: print from there with Ctrl+P. (The app's own printing could only show Windows' print
  dialog, with no preview.)

## 2.43.1
- Certificates: a cut-out is **trimmed to the model**, so it fills the photo frame instead of sitting in a sea of
  empty space. On by default (**Trim the empty space around the model**), with **Space around it** to leave more or
  less room; the preview shows what's kept with a dashed outline.

## 2.43.0
- Certificates, **Remove the background**: a better automatic cut-out. The AI looks twice (the whole photo, then
  closer at your model for sharper edges), each time also at a mirror image of the photo, and loose specks and faint
  haze of background are cleaned up. It takes a little longer (about half a minute the first time).
- **✨ Let Claude fix it** (with your API key, a few cents): Claude looks at the photo and the cut-out, marks the real
  object (not reflections, shadows or the table it stands on), the cut-out is trimmed to that, and Claude checks the
  result. It says when it looks clean, or shows red boxes where background is still left. Counted as “Certificates:
  Claude photo check” in AI spending.
- Fix it yourself: **✂ Box around the model** (drag a box: everything outside goes, and the AI looks closer inside),
  **🧽 Erase** and **🖌 Restore** brushes with a size slider, **↶ Undo** (Ctrl+Z) and **Start over**.
- Reflections in a glass or glossy table were kept as part of the model (they touch it): a box, Claude or the Erase
  brush now take them away.

## 2.42.1
- Certificates: **Remove the background** could not be turned on the first time: the box unticked itself and the
  button to download the background remover couldn't be clicked. Now the box stays ticked, a blue **⬇ Download the
  background remover** button appears, and your model is cut out as soon as the download finishes.

## 2.42.0
- Certificates: **Remove the background** is now done by an AI model on your PC (BiRefNet), so it cuts the model out
  cleanly, even fine leaves and lashes, where the old way left smudges and holes. The model downloads once (224 MB,
  checked before it's used, then it works offline) and takes a few seconds per photo. Your photo never leaves your
  PC. The cut-out sits right on the certificate, so the background always matches the template, even if you switch
  templates later.
- Certificates: the AI names and sayings can be folded away (**▾ Hide ideas** / **▸ Show ideas**) so they don't take
  up the page.
- Print history: **📊 Stats…**, **📄 Report…** and **↻ Refresh** sit in one row under the note, as clear teal
  buttons (they were squeezed beside the note, with their names broken over two lines).

## 2.41.0
- **📊 Print stats…** on the Print history tab: a window with how your prints went, across all your printers.
  - The share of finished prints that **completed**, were **cancelled** or **failed**.
  - **Hours of successful printing** and **hours wasted** on cancelled and failed prints, in hours and minutes.
  - **Filament used** on all printers, the filament **wasted** on cancelled and failed prints, and **what it cost**
    (at $15 per 1 kg spool; change the price to yours).
  - **Each printer**: its completed, cancelled and failed rates, times, filament and cost. A printer with clearly
    more problems than the others is flagged.
  - **Every print, start to finish**: a timeline per printer, colored by how each print ended (green completed,
    yellow cancelled, red failed, blue printing now). Hover a print for its details.
  - **Prints over time, by printer**: completed, cancelled and failed prints per day, week or month.
  - Pick the period (7 days to all prints), how much history to read, and **metric or imperial** units.
- Certificates: **✨ AI ideas** works with every model again (it was turned down with “tool_choice … not supported for
  this model”, e.g. on Opus 5.5).
- Print history: a **status filter** (All prints, Completed, Cancelled, Failed, Printing now) and a **search box**
  for the print's name, with a count of the matching prints.
- Print report: **🏅 Certificate…** shows only on completed prints (as in Print history), not on cancelled, failed
  or still printing ones.

## 2.40.1
- Certificates: **AI ideas** now go through the app's single Anthropic request (the same one the rest of the app
  uses), so errors read the same everywhere and spending is always counted.
- Certificates: saved AI ideas keep only the names and sayings. Ideas saved with 2.40.0 aren't shown again; click
  **AI ideas** to get new ones.
- Security: code scanning alerts closed.

## 2.40.0
- Certificates: **✨ AI ideas**. Claude looks at the model (the slicer's picture and your photo) and suggests 8 fun
  names (a grand title like “Sir Toothless the Very Brave”, cute, punny, epic, funny and simple ones) and 6 short
  sayings that suit the template (Christmas, birthday, kids…). Click one to use it; **More ideas** asks for new
  ones. The cost is shown first (a few cents each time, with your API key) and is counted under “Certificates: AI
  ideas” in the AI spending list. The ideas are kept with the print.
- Certificates: **🎨 Touch up photo**, with a live preview and sliders for exposure, contrast, saturation, warmth,
  hue and sharpening. **✨ Auto-fix** sets the sliders from the photo's own brightness and colors; **Hold to
  compare** shows the original. **Remove the background** finds the background from the photo's edges (it picks
  its own strength, which you can change) and puts white, the certificate's paper color or a soft studio backdrop
  behind the model. Your original photo is kept: touch it up again or **Undo touch up** any time. All done on this
  PC.
- Security: certificate templates are checked by exact name (code scanning).

## 2.39.1
- **🏅 Certificate…** on each completed print in the **Print history** tab: opens the certificate for that print straight away.
- Certificates: a long name or message gets smaller type to fit, instead of pushing other lines off the page.
- Certificates: when the message is still too long, it ends with “…” on the last line that fits and the editor says so.
- Certificates: the photo frame takes the photo’s shape (wide or tall), so there are no white bars above, below or beside it. The Show and Up / down controls are gone, as they’re no longer needed.
- Fix: print times could read “5 h 60 min” (now 6 h 00 min); pattern names read as words (“adaptive cubic”, not “adaptivecubic”).
- Certificates: an optional **Weight** field for the finished model (grams if you type just a number, shown with ounces; or type it your way, like “1.2 lb”). Left empty, it isn’t on the certificate.
- Security hardening (code scanning alert): the print report and certificates only show pictures that are image data made by the app, escaped, never other text put into the page.

## 2.39.0
- **Print report** (Print history → 📄 Print report…): a window with a report of your prints, to print or save as a
  PDF. Pick the prints by date, printer, status and name (e.g. “ornament”), untick any to leave out, and give it a
  title (“Christmas gifts 2026”).
  - **Summary**: totals (prints, completed/cancelled/failed, printing time, filament in metres and kg, filament cost
    once settings are read), how far all that filament would stretch, and one row per print with its picture,
    status, print time (and planned), filament used, material colors, and the Print Monitor's comparison (“≈ the
    height of the Statue of Liberty!”). Prints still running show their planned amounts.
  - **Detailed (with settings)**: also a page or two per print with the settings it really used, read from its
    G-code on the printer: profiles, filament per toolhead (weight, length, cost), then Quality (layer heights,
    line widths, seam, ironing…), Strength (walls, shells, infill), Speed (each feature, accelerations), Support and
    adhesion (type, style, distances, interfaces, brim, raft), Multi-material (toolhead changes, prime tower,
    purging) and Temperatures and cooling. Settings AI 3D Print Advisor changed are marked. Only the end of each
    G-code is read (about 0.2 MB, read-only), and each print is read once.
  - The history behind it reaches further back (100, 300 or 1000 prints per printer).
  - **🏅 Certificate…** on each print: a colorful one-page “birth certificate” for the model, to give with it
    (landscape, print or save as PDF). A large photo, the name you give it, To and From, an optional message, when
    it was started and finished (date and time), time in the making, where it was printed, height, layers, layer
    height, filament, material colors, walls and infill, and how far its filament would stretch. Six templates, each
    with its own wording, colors, fonts and decorations: Fancy, Professional, Kids’ toy, Christmas gift, Birthday
    gift and Rainbow. The photo: one from this PC, one taken with a phone (scan the QR code, as in the
    troubleshooter: take a photo or pick one already taken, and it appears on the certificate), or the Print
    Monitor’s 99 % camera photo of that print; without one, the slicer’s picture. Fill the frame or show the whole
    photo, and move it up or down. Each print’s certificate is kept. Photos taken for a certificate never go to the
    troubleshooter.
- **Filament → Dashboard: when you last added spools.** Two new tiles: **Last added from an order** (with the newest
  order date) and **Last spool added by hand**. Click either to see the spools added, newest first, grouped by day,
  with how each was added. Compare with your Amazon orders to spot ones you haven't added yet. Works for spools
  added before this version too; new spools record how they were added.
- Fix: the troubleshooter could keep a G-code download that stopped part way and treat it as the whole file. The
  size is now checked, and a cut-off copy kept from before is downloaded again.

## 2.38.0
- **Color gaps** (new tab on the Filament screen): finds where the colors you have on hand leave medium or large
  holes, per material, with checkboxes for the finishes to include (Matte, Silk, Galaxy, Gradient, Color Change…).
  The colors that would fill the most are ranked by how much of the missing color range each fills, with the
  closest color you already have. Free and offline. **Find products for the top 10** has Claude search Amazon
  first, then the makers' own stores (cost shown first, your API key); the app opens every link to check it, leaves
  out broken ones, and shows each product's price, store, color match and photo (click to enlarge). The last
  report is kept.

## 2.37.7
- **Toolheads lock while you're not changing them.** Every change to a toolhead's material or color used to set
  the whole project up again straight away, which slowed the computer and made it hard to keep picking colors.
  Now you click **✎ Change toolheads**, make all your changes (the 3D view recolors as you go), and click **✓ Done**:
  the project is set up once. **Cancel** puts them back as they were. Recommendations, Save, Slice and Send apply
  any unfinished changes first, so nothing runs with the old toolheads.
- **Print Monitor: Pause, Resume and Cancel can only happen after you confirm.** Fixed a flaw in the confirmation
  box: closing it with Esc (or the window) could count as the "yes" from an earlier box. Now only a real click on
  the box's own Pause / Resume / Cancel button sends anything, "Keep going" is the default, and the controls ignore
  anything but a real click. (The app's log showed the pause reported on 25 November wasn't sent by this app.)
- **When a print pauses, the monitor says whether this app did it.** The alert and the log say "not by this app"
  when the pause came from somewhere else (the printer's screen, another program or Home Assistant, a sensor).

## 2.37.6
- **Clean-release supports** (new option under "What is this part for?"): prints the support interface in the
  opposite material (PETG under a PLA model, PLA under a PETG model), which doesn't stick to the model, so supports
  lift off and leave an almost flawless underside. The app sets the supports up for it whatever the AI suggests:
  no gap between roof and model (top and bottom Z distance 0), a solid interlaced roof of 3 layers (and 2 where
  supports stand on the model), normal grid supports instead of trees (the model would slide off small tips), roofs
  reaching 1.5 mm past each overhang, a denser support body so roofs don't sag, support for overhangs up to 40°, the
  support body in the model's own material, and the prime tower on. It's offered for PLA and PETG models and needs
  the other material loaded in a toolhead (it says so until then). Checked with a real Snapmaker Orca slice.
- **Orientation keeps the visible top looking good.** Each orientation now has a **Look** line: whether the top and
  sides people see print smooth, as designed, or how much of them would be printed on supports (rough, support
  marks). Supports on the visible top or sides count much more than supports on the hidden underside, so the app no
  longer suggests flipping a figure, statue or bust upside down (or onto its side) just to save some support
  underneath. The AI is told the same: how the print looks comes first.
- **Opening a model clears "What is this part for?"**, so text written for the last model isn't used for the new one
  (a restored session still brings its own text back).

## 2.37.5
- **Updates go straight to the newest version.** Check for updates / Install and restart now always installs the
  newest release, however many versions behind you are, instead of a version found earlier (at launch or the day
  before) that a newer release has since replaced. The update window shows which version it's installing.

## 2.37.4
- **Accent lights in the photo settings** too (under **⇲ Adjust**): the lights in the photo (Christmas tree lights,
  candle flames, the fire, lamps) are picked out and keep shining when you switch to **Evening** or **Night**, while
  the room around them goes dark; the slider dims them, turns them off (0) or makes them brighter (2).

## 2.37.3
- **⇲ Adjust in the built settings** (garden, shelf, mantel, porch, Thanksgiving, Christmas, desk, kitchen, Halloween,
  kids' room), with:
  - **Accent lights**: dims, brightens or turns off the setting's own lights: the kitchen's under-cabinet lights, lamps,
    candles, the fire, Christmas tree lights, jack-o'-lanterns, the desk monitor and lamp (0 = off). Handy at Night or
    with Lights off so only the glow-in-the-dark print lights the room.
  - **Glow intensity** (when a filament is glow in the dark), as in the photo settings.

## 2.37.2
- **Night in the photo settings glows like Lights off**: glow-in-the-dark filament gets its halo, and its light pools on
  the table or shelf under the model.
- **Glow intensity** slider under **⇲ Adjust** (shown when a toolhead is set to glow in the dark): how brightly it
  glows, its halo and the light it throws.
- Fixed: glow-in-the-dark **painted** on part of a model (a figure's antlers, say) didn't light up its surroundings or
  get a halo, on the plate with Lights off or in a setting at night; only whole glow parts did.

## 2.37.1
- Photo settings, **⇲ Adjust**: **Left / right** and **Back / front** now move the model across the photo (back = further
  away: higher up and smaller; front = nearer, lower and bigger); before, they did nothing visible, and Back / front at
  the far end lost the model's shadow. The shadow now follows the model at any size.
- New **Photo brightness** and **Model brightness** sliders (and **Reset**) under Adjust.
- **Evening and Night are much darker** in the photo settings, for both the photo and the model (the shine of silk,
  chrome and galaxy finishes dims with it; glow-in-the-dark filament still glows at night).

## 2.37.0
- **See it in place**: the 🏠 picker under the 3D view puts the model in a setting, at its true size, with real shadows
  and the setting's own light: **Garden table, Bedroom wall shelf, Fireplace mantel, Front porch by the door,
  Thanksgiving table, Christmas, Desk / home office, Kitchen counter, Halloween, Kids' room toy shelf**. The setting stays
  put; drag to turn the model (up/down tilts the view a little), scroll to zoom, ⟳ Spin turns it on its spot.
  **Day / Evening / Night**: lamps, candles, the fire, the Christmas tree and jack-o'-lanterns light up, and
  glow-in-the-dark filament glows. **True size / Fill the view.** Every filament finish shows in the setting.
- **Photo settings**: 8 sharp photos to stand the model in: **Christmas table, Christmas by the fireplace, Dining
  table, Dining table by the window, Sunny wall shelf, Wall shelf with plant, Winter snow, Kitchen counter (marble)**.
  The photo stays put and the model stands on its table or shelf with a soft shadow, lit to match the photo; drag to
  turn it, scroll to zoom, ⇲ Adjust to change its size and place. Built into the app (no download).
- **My photo**: use your own photo (your real shelf, desk or room) as the backdrop: the model stands in front of it with
  a soft shadow, lit to match the photo; sliders set its size and position. Your last six photos are kept in the list.
- **📷 Save picture**: saves what you see as a PNG.

## 2.36.1
- Fixed: setting one painted colour of a model to **Translucent** broke the other colours on the same object (the solid
  colours showed through each other). Only the translucent parts are see-through now.

## 2.36.0
- **Filament finishes in the 3D view**: the button next to each toolhead's color (the old ✦ galaxy button) now picks
  the finish: **Normal, Galaxy / glitter, Silk** (glossy, pearly sheen and fine layer lines), **Matte** (flat, no shine),
  **Translucent** (see-through, light at the edges), **Glow in the dark** or **Chrome** (mirror). It's guessed from the filament's name
  ("PLA Silk", "Matte PLA", "Glow…", "Chrome") and can be changed. Silk is very shiny and reflects a studio around it;
  **Chrome** is a mirror finish, the most reflective of all (tinted by the filament colour); matte has no reflection.
- **Warnings for filaments that are hard on nozzles** (carbon fiber, glass fiber, glow in the dark, metal-, stone- or
  ceramic-filled): under the toolheads and in Send to printer, so you fit a hardened steel nozzle first (a standard brass
  or stainless nozzle wears out quickly). Shorter notes for wood-filled, flexible (TPU), nylon/PC and ABS/ASA filament.
- **⟳ Spin** above the 3D view: the model turns slowly under the lights while the view rises and dips, so you see how
  each finish catches the light from different angles (drag the view to stop).
- **☾ Lights off** (with a glow-in-the-dark toolhead): the room goes dark and the filament glows like a real
  glow-in-the-dark print: its glow colour (white/pale filament the classic aqua-green, coloured filament its own colour),
  brightest where it faces you, with glowing thin edges and its layer lines and shape still readable, lighting the bed
  and the parts around it, with a soft halo.

## 2.35.1
- Send to printer: the bed check now reads “the print uses X 57–200, Y 2–197 mm of the 270 × 270 mm bed”, so it’s
  clear which numbers are the print and which are the bed.

## 2.35.0
- **Safety: a print that would leave the bed is never sent.** A wider brim or skirt next to the bed edge pushed a
  print's first layer past the front of the U1's bed (the printer stopped with "Axis movement anomaly … Y-axis movement
  exceeded travel limit"). Every move of the sliced print is now checked against the printable area before sending;
  when it doesn't fit, the app moves the print back on by the measured amount, slices again and checks again, and if
  it still doesn't fit, **Print is blocked** (the upload itself refuses it too).
- **Checked before every print** (like Snapmaker Orca does before it lets you print): outside the bed, too tall, no
  layers, no extrusion, a layer too thick for the nozzle, broken numbers, temperatures out of range, a cut-short file,
  and errors Snapmaker Orca reported while slicing. Real problems block Print; the rest are shown as warnings.
- **Preview of the sliced print** in Send to printer: the exact file that will be sent, in 3D, in Orca's colours, with
  each feature (walls, infill, supports, skirt, brim…) shown or hidden and a layer slider.

## 2.34.2
- **The troubleshooter opens the plate that was printed.** For prints whose file name doesn't say the plate, it matches
  the objects in the printed G-code to the model's plates (e.g. "Wings Redo" → the plate with the two wings). A
  **Plate** chooser shows every plate and how many printed objects it matches; your choice is remembered for that print.
  Print fixed version, Save fixed 3MF and Use these settings use that plate.
- Fixed: **Settings in this print** reported per-object settings as missing. Orca renumbers objects in the sliced
  project it exports, so they're now matched by name (they were in the print; the check looked in the wrong place).

## 2.34.1
- **Send to printer shows the settings the print will really use**, read back from the sliced file that is about to be
  sent (not from what the app meant to change): every changed setting with ✓, or ⚠ when it isn't in the print, the layer
  height measured from the toolpaths themselves, settings on single objects checked in the sliced project, and the
  print's main settings (layer height, walls, infill, supports, temperatures).
- Send to printer always slices the version exactly as it's ticked now (it could reuse an earlier slice of it).
- Fixed: after **Use these settings** in the troubleshooter, the fixes and the Send to printer / Save buttons stayed
  hidden behind the empty Recommendations page.
- **🖨 Print fixed version…** in the troubleshooter: prints the model with every fix you ticked (the layer height
  included), straight from the app: it opens the printer dialog with the fixed version sliced and ready.
- **The troubleshooter keeps its diagnosis.** Reopening a print shows its last diagnosis right away, with no new AI
  request (before, a print just diagnosed still looked undiagnosed until the history was reloaded, which invited
  paying for the same diagnosis again). Earlier diagnoses of that print are in a list (the ones that change the layer
  height are marked); **Run a new diagnosis with Claude** asks again only when you want. Your ticks and edited values
  are kept, and the model you picked for that print is remembered.
- **Troubleshooter fixes stay** when you then click Get new recommendations: the new advice is added, the fixes are
  kept (marked “From the troubleshooter”), and Send to printer / Save as 3MF use all of them.

## 2.34.0
- **Settings per object, in one file.** Files with several plates, or several different objects on a plate, can now
  get different settings for different objects, saved on the objects themselves (the same as right-click → Add settings
  in Orca). Checked with Snapmaker Orca's own slicer: each object prints with its own walls, infill, layer height…
  - **Saving recommendations for one plate** of a multi-plate file now changes only that plate's objects; the other
    plates keep their settings. Settings Orca can't set per object (filament temperatures, first-layer height, prime
    tower…) still apply to the whole file, and the app says which.
  - **Troubleshooter → Save fixed 3MF** puts the fixes only on the plate that was printed.
  - **Analyze all objects (N)**, next to Get recommended settings: one AI request per *different* object (copies and
    near-identical objects, like a set of similar pegs, are analyzed once and share the settings). Shows the number of
    requests and the expected cost first. Then pick an object to see and edit its settings; settings that must be the
    same for a whole plate are listed once, and when objects disagree you choose the value. Save, Compare, Send and
    Open in Orca use every object's settings.
- **Fixed: a new layer height could be ignored in Orca.** Some models set their own layer height on the object, or use
  a variable layer height; Orca uses those instead of the project's layer height, so the file still printed (and showed)
  the old one. Changing the layer height now removes them where they'd override it, and says so. Height ranges the
  designer set (e.g. a finer section) are kept.

## 2.33.0
- **Take the troubleshooter's photos with your phone**: in the print troubleshooter click **📱 Take photos with your
  phone** and scan the QR code. Your phone opens a page with a big **📷 Take a photo** button. Already took them? **🖼 Choose
  from your photos** or **📁 Browse the phone's files** (Downloads, other folders), several at once. Each photo appears in
  the troubleshooter a moment later, over your home Wi-Fi. No cloud storage, no downloading, no app
  to install. A phone that isn't paired yet pairs right there with the same QR code.
- Snapped photos at the printer before opening the troubleshooter? Paired phones also have a **📷** button on their
  Filament page. The photos wait on the PC: ones from the last 2 hours go into the next troubleshooter by themselves,
  older ones are one click away. Delete any photo on the phone or the PC (✕); they're kept for 14 days.
- **💾 Save fixed 3MF…** in the troubleshooter's results: saves a copy of the model with the ticked fixes built in, in one
  step, without leaving the troubleshooter. It uses the model the app knows for that print, or asks once for the project
  file (.3mf) you sliced in Orca. The new file is named after what it fixes ("Rocket (advisor - Fixed stringing - …).3mf"),
  next to the original, which stays as it was. Double-click it to open it in Snapmaker Orca and print.
- Fixed: turning on phone access's **secure address** for the first time (or after the PC's address changed) could fail
  with "BAD_DECRYPT", so the secure address didn't start.

## 2.32.3
- **Zoom**: make everything bigger (or smaller) for easier reading: **Settings → General → Text and screen size**, the
  **View** menu, **Ctrl +**, **Ctrl −**, **Ctrl 0**, or **Ctrl + mouse wheel**. It applies to every window (the main window,
  the Print Monitor, the Filament screen) and is remembered.
- **The printer bar's height can be changed**: drag its bottom edge. The printer cards, pictures and text grow and shrink
  with it, keeping their proportions (double-click the edge for the normal size). Remembered too.
- The main window keeps opening on the monitor you last used it on (since 2.32.2), like the Print Monitor.

## 2.32.2
- The Print Monitor window opens where you left it: the same monitor, place and size (and maximized if it was).
  The main window does too. If that monitor isn't connected any more, it opens on the main screen.

## 2.32.1
- Print Monitor hardening (found by the code scanner): pictures from a printer are only saved when they really are a
  PNG or JPEG of a sane size, never written over an existing file, and a printer's status messages can only fill in
  printer values.

## 2.32.0
- **Print Monitor**: watch every printer from the app. A bar on the main screen shows what each printer is doing
  (thumbnail, progress, time left, when it ends); **Print Monitor** opens a window with every printer side by side and
  a full page per printer: live camera, the print's preview pictures, progress and layers, **elapsed time, time left,
  estimated duration and end time**, toolhead temperatures with each filament's color, bed and enclosure, fans and
  speed, lifetime totals, pause / resume / cancel (each confirmed), **timelapse videos** and **final photos**.
- **Lifetime print time** from each printer's history: all printers together in the bar on the main screen (hover it
  for each printer), each printer's in its hover card, and a strip on the Print Monitor's All printers page.
- Hover over a printer in the bar for a bigger card: a larger picture of the print, time left, end time, elapsed,
  estimated duration, layer, filament used and the toolheads.
- Built in from U1 Studio and the Home Assistant dashboard's scripts, so nothing else has to run: the Snapmaker U1
  camera keep-alive, a photo at 99 % while the part is still on the bed, layer-by-layer preview pictures drawn from the
  G-code, and the print stages (preparing, printing, cooling, ready to remove). Time left is worked out like Home
  Assistant's and Mainsail's "Print ETA" (the slicer's plan scaled to the print's real pace).
- **Alerts** (Settings → Print monitor): Windows notifications, phone push with **ntfy**, and **email** like the Home
  Assistant automations (a camera photo and the printer's numbers at 1 / 25 / 50 / 75 %, and the final photo when it's
  done and the bed has cooled). Choose per alert which ones you get.
- Works with any Klipper / Moonraker printer, using the printers and API keys already in Settings; a Snapmaker U1 also
  gets its built-in camera, four toolheads with filament colors and timelapses. Other cameras: a snapshot or MJPEG address.
- Keeps watching from the **tray** when the window is closed (so alerts and the 99 % photo aren't missed), and can
  **start with Windows**. Paired phones get the Print Monitor too (**🖨 Printers** on the phone page).
- **Settings is now in tabs**: General, AI, Printers, Print monitor, Filament, Phone.
- The progress bar (starting up, slicing, reading…) now sits at the bottom of the window, so it never covers the menus.
- U1 Studio users: **Settings → Print monitor → Bring over settings and photos from U1 Studio**, then stop U1 Studio
  from starting with Windows so alerts don't come twice.

## 2.31.0
- **Filament prices.** Each filament's details now have a **Prices** section: the **average cost per roll** (total
  spent ÷ rolls), last and lowest price paid, and a **graph** of what you paid for each roll over time. **Check prices
  now** has Claude search the web (your API key, usually a few cents) for that exact product at Amazon, the brand's
  store and other filament shops, flags sales, and shows how much less (or more) than you last paid; found prices are
  kept, so the graph builds a history. **camelcamelcamel** and **Keepa** buttons open Amazon's price history for it.
- The Dashboard shows the **average per roll** for your whole library, filaments that are **cheaper now than you last
  paid**, and a button to check prices for everything running low.
- **Phones: easier secure scanning.** With the secure address on, pairing walks the phone through installing the
  app's certificate (it checks by itself when it's trusted), then pairs on the secure address. The certificate is also
  a QR code in **Settings → Phone access** and under **⚙** on the phone page. Links on labels and stickers move to
  the secure address on phones that trust it.
- **Android: tapping a sticker no longer pops up Android's “New tag scanned” screen** while the filament page is open
  on the secure address: the page keeps listening for stickers (allow it once).

## 2.30.0
- **Your filament library on your phone** (iPhone and Android), on your home Wi-Fi: turn on **Settings → Phone access**,
  click **Pair a phone** and scan the QR code. Look things up, update spools (open, empty, move, weigh, log grams),
  and add filament, including from a photo of an order (read by Claude with the API key on your PC). Changes show up
  on the PC and other phones at once. Add it to the Home Screen to use it like an app. Works while the app is open on
  the PC; only paired phones get in.
- **Scan spools with the phone**: printed labels now have a QR code that opens the spool (the phone's camera app is
  enough), stickers the app writes link to their spool (tap with the phone), and a scan on the PC's NFC reader opens
  the spool on the phone too. An optional **secure address** adds a Scan button inside the page (camera, and NFC on
  Android), after the phone trusts the app's own certificate once.
- Phones that can’t find the PC by name (some Android phones) use its address, and labels and stickers link to that
  address too; Settings says so (reserve the address in your router).
- **Linking a tag to a spool** narrows it down step by step (type → brand → color → filament → spool) instead of one
  long list; a step with one choice picks itself, and the spool is shown to confirm.
- NTAG203/213 stickers, too small for the filament's details, now get the spool link instead.
- The Filament screen saves safely when several screens edit at once (a save based on old data is refused and reloads).

## 2.29.0
- **Spool tags (NFC/RFID).** Turn it on in **Settings → Spool tags** and tap a spool on an NFC reader: a spool
  you've scanned before opens, highlighted; a new one can be added with its brand, material, color, weight and
  temperatures filled in from the tag, or linked to a spool already in your library. Reads Bambu Lab, Snapmaker
  (signature checked), Creality, QIDI, Anycubic and ELEGOO tags and the OpenSpool, OpenTag3D, SpoolEase and TigerTag
  formats. Contributed by BSDGuyShawn (PR #10), with the tag decoders from OpenRFID.
- **Write your own filament to NFC stickers.** On a filament's card, **🏷 Write NFC tag** (or 🏷 on a spool) writes
  it to a blank NTAG215/216 sticker as OpenSpool (or OpenTag3D, with the color name), reads it back to check, and
  links the sticker to that spool. Stickers that are too small (NTAG203/213) can be linked by their ID instead. Only
  blank-style stickers are written: brand tags, locked stickers and the sticker's system pages are never touched,
  and a sticker that already has data asks first.
- **Readers**: USB NFC readers (ACR122U, ACR1252U, Cryptnox, HID Omnikey, Identiv… any PC/SC reader), an
  **Arduino with a PN532 shield** (sketch in `tools/arduino/SpoolTagBridge`), or a **PN532 board** on a USB-serial
  adapter. Pick and test them in Settings; only Arduino boards are ever tried automatically.
- All built in: the tag reading, decoding and writing run inside the app (no Python, no extra program), in a
  background process so the window never waits on the reader. `npm test` runs the tests (`test/`), including every
  tag format against real tag dumps.

## 2.28.1
- **Color remix schemes show the full filament for each color**: color, brand and line, material, finish, spools on
  hand and how much is left, in both Swap colors and recoloring by parts. Swap colors also shows it under each color
  you pick, and each scheme lists what every toolhead changes from and to.
- **Apply to model** on every Swap colors scheme and at the bottom of the list, so there's no scrolling back up.

## 2.28.0
- **Color remix: Swap colors**, a simpler way to recolor that opens first. The model keeps its painting exactly as
  it is; each of its colors gets another filament from your library. Pick them by hand, click **Closest match** (the
  filament you own that looks most like each color) or **Shuffle** (a random scheme that keeps light colors light
  and dark ones dark, so eyes and details still stand out), or let the AI suggest schemes in the styles you pick
  (a few cents). The 3D view shows each change, color mixes follow the new colors, and **Apply to model** sets the
  toolheads to those filaments with their Snapmaker Orca presets. **Undo remix** undoes it. Recoloring by parts is
  still there (Parts and Colors at the top of the window).

## 2.27.0
- **The guided tour is optional.** The app no longer starts in the tour. New users who say they're new to 3D printing
  are offered it once; everyone else never sees the offer. Anyone can take it from Settings, and **Exit the tour**
  (bottom right) leaves it anytime. Finishing it no longer requires setting up the AI first.
- **A short setup window** on first launch for whatever isn't set up yet: the AI (your own API key or the free
  chatbot) and Snapmaker Orca. "Later" is fine: Settings has both.
- **Sample filament library**: the first time you open Filament (with an empty library), choose to explore the
  sample library or start empty. Settings has a new **Filament library** section to remove the samples when you're
  done (anything you added yourself stays, and a backup is kept), or to load them later. Before, the library was
  only in the tour and came up empty afterwards.
- The cheat-sheet booklet offer waits until no other window is open.
- Security (code scanning): the updater starts its hand-over script by a fixed name instead of a full path, and the
  cheat-sheet tool strips HTML tags completely.

## 2.26.1
- **Every filament in the file is kept**: a project with more solid filaments than the printer has toolheads (for
  example 5 colors plus 2 color mixes on the 4-toolhead U1) now shows all of them. Before, the 5th and later were
  dropped from the list. A note under the toolheads says when there are more filaments than toolheads; that's
  fine for files shared for Bambu printers with an AMS, which load 16 or more colors. You can also add filaments
  past the toolhead count.

## 2.26.0
- **Share on MakerWorld, easier to find**: "For MakerWorld (Bambu)…" buttons next to Save as 3MF (for the
  recommendations and for any version in Compare slices), and a "Share on MakerWorld" link under Open in Snapmaker
  Orca. They save a Bambu Studio project made by Bambu Studio itself (needs Bambu Studio, free from bambulab.com).
  The printer you pick is remembered.
- **Color mixes come along**: Snapmaker Orca color mixes become filaments of their own in the blended color, so the
  model looks the same in Bambu Studio and on MakerWorld. (Before, those areas pointed at filaments the Bambu file
  didn't have.)
- **The purge tower fits**: it now goes where it has room to grow, and if the model leaves no room, the model slides
  forward or back to make space. Before, a busy multi-color model could grow the tower off the bed and Bambu Studio
  refused to slice it.
- Fixed Bambu Studio crashing while saving a file with more than the usual number of filaments.

## 2.25.0
- **Find models**: a new button at the top (and a "Find free models" link where you open a file) lists where to
  download models to print. **Snapmaker Space**, Snapmaker's own site with ready-to-print U1 files, comes first.
  Free: MakerWorld, Printables, Thingiverse, Thangs and Yeggi. Paid: Cults, MyMiniFactory, CGTrader, Gambody,
  Patreon creators and Etsy. Tips cover 3MF vs STL files, licenses, and checking other people's prints.
  The guided tour shows it too.

## 2.24.0
- **Everyone takes the guided tour once**, including people who set the app up before the tour existed. It runs on
  the sample rocket with recorded results, so the first experience is quick and the same for everyone (no waiting
  on a big model of your own). It covers every feature: recommendations, Compare slices, Color remix, the filament
  library, print history and the troubleshooter, before your filament library is emptied for real use.
- **The tour now sets up the real app**: creating an Anthropic account and adding credit, creating an API key just
  for this app (so the Console shows exactly what it costs, and you can switch it off on its own), or choosing the
  free chatbot instead, and finding Snapmaker Orca (with a download link and Browse if it isn't installed).
  **Finish the tour** unlocks once the AI is set up; then the app restarts in normal mode where everything is real.
- After the tour, the app offers the **printable booklet** once: open it to print, save a copy, or get the 1-page
  quick sheet.
- **Saved 3MF files say when they were made**: "Rocket (advisor - 2026-11-19 3.42 PM).3mf", and
  "(advisor - Fast - …)" for a version from Compare. Converting many files and the Bambu export do the same.

## 2.23.1
- **The guide stands out more**: a bright orange window, and the "Click here" highlight and the "Click …" line are
  now bright cyan, so the next thing to click still pops against it.
- **Meet the wizard**: the first guide screen shows an animated wizard waving his wand at a Snapmaker U1, turning a
  spaghetti mess into a dragon. His face is the guide's icon on every step.

## 2.23.0
- **Updates built in.** The app checks GitHub for a new version when it starts and once a day while it's open.
  When there is one, it shows **what's new** since your version, and **Install and restart** updates it **in place**
  (same folder, no new download warnings). Only releases that passed GitHub's virus scan are installed, and the
  download is checked against the published SHA-256 checksum. Settings, API key, filament and history are kept.
  Settings → **Check for updates** (and an option to turn the automatic check off). The download is now called
  `AI-3D-Print-Advisor-Studio-win-x64.zip`, without the version, so the folder stays the same.
- **Snapmaker Orca color mixes** ("Full Spectrum" mixed filaments, where thin layers of 2–4 filaments blend into a
  new color) now show: under the toolheads with their recipe (e.g. T1 60% + T2 40%) and blended color, and in the
  3D view, so the model looks like it does in Snapmaker Orca. Changing a toolhead's color updates its mixes.
- Fixed: a file using color mixes was prepared as if each mix were another real filament (e.g. 7 filaments on a
  4-toolhead U1). Mixes now count as the real filaments they're printed with.
- **Sparkly filament in the 3D view**: galaxy, glitter and sparkle filaments (detected from the filament name, or
  switched with the new ✦ button next to each toolhead) get tiny glinting flakes, like the real thing. Mixes that
  use them sparkle too.
- Guide fixes: it moves on as soon as a model opens (it used to wait until the app finished preparing it), reacts
  to clicks straight away, and says when the app is busy (e.g. slicing for Compare slices) instead of looking stuck.

## 2.22.0
- **Printable cheat sheets** (PDF, US Letter): a **1-page quick sheet** and a **booklet** with setup, why prints
  fail, a troubleshooting table and every 3D printing word with its picture. Open them from the Glossary window or
  Settings; they're also in a "Printable cheat sheets" folder next to the program, and on GitHub.
- **Good to know**, under every set of recommendations and every troubleshooter result: what settings can't fix
  (damp filament, the room and temperature swings, the filament itself, the printer's condition and calibration,
  the model) and that AI can make mistakes, especially with little to go on.
- The guided tour has a new step about this, and points to the cheat sheets.

## 2.21.0
- **The demo is now built into the app** as a one-time **guided tour**: the first time you open the app it walks
  you through every feature on the sample rocket with recorded results (nothing is sliced, printed or sent to AI,
  and your settings and filament aren't touched). **Finish the tour** to unlock the app for your own models: it
  restarts once, fresh, with an empty filament library. It never runs again (Settings → "Take the guided tour
  again" replays it). People who already used the app aren't sent through it. There's no separate DEMO download
  any more.
- New tour steps: the **Glossary** (a great way to learn the terms), **Settings** (the gear) and the **API key**:
  where to paste it, why the app needs one (it works with Claude on its own; a chatbot needs copy and paste every
  time) and what it costs (a few cents per analysis). A key saved during the tour is kept.
- The experience level picked in the tour carries over.

## 2.20.1
- Removed the optional Anthropic **Admin API key** and the "Check this month on Anthropic" button from
  Settings → AI spending: they only worked for Anthropic organizations. Any admin key saved earlier is deleted
  the next time Settings is saved. Settings now links to your **API keys page** in the Claude Console, which
  shows what your key has cost in total. The app's own record of what it spent stays.

## 2.20.0
- **Guide you can't miss**: the step-by-step guide (beginners and the demo) is bigger and brighter, and at every
  step a pulsing orange **Click here** ring sits on the exact button to press next, with "Click ..." spelled out in
  the guide. It follows you through windows step by step (Color remix: Identify parts, Confirm parts, Generate,
  Apply to model; the troubleshooter; the demo's model picker; the Filament screen).
- The guide moves itself to whichever corner doesn't cover the button to click or the window's other buttons, so
  it no longer sits on top of what you need (it used to cover "Generate" in Color remix).

## 2.19.2
- Word explanations: **STL file** has its own picture (it showed the 3MF one), and the **3MF file** picture
  labels all three parts: model, colors and settings.

## 2.19.1
- **Tidier download**: the unzipped folder now holds just one program to open (`AI 3D Print Advisor Studio.exe`,
  or `... DEMO.exe`) and an `app` folder with everything else. The zip no longer has a folder inside it, so
  "Extract All" no longer makes a folder within a folder of the same name.

## 2.19.0
- **3D printing words explained** (for "Brand new" and "A little"): words like brim, infill, nozzle, prime tower,
  purge, "Generic PLA", toolhead and about 45 others get a dotted underline. Hover over one to see a plain-language
  explanation with a drawing; click it to keep the explanation open. Works everywhere in the app, including open
  windows (Color remix, Settings) and the Filament screen, in the full app and the demo.
- **Glossary** button at the top: every word with its drawing, searchable.
- Settings: "Explain 3D printing words" switch, so anyone can turn the underlines on or off.

## 2.18.0
- **Runs on Electron 45.4.1** (was 33.2.1), the official build from the Electron project. Clears the published
  Chromium/Electron security advisories and the antivirus "packed program" flag some scanners raised on the
  old launcher. Saved API keys keep working.
- New app icon; the program shows its own name and version in Windows.
- **Very large models open**: model files bigger than JavaScript can hold as text (a 619 MB MakerWorld model) are
  read in chunks, and **Fix model** lightens them (6.9 million → 1 million triangles in about a minute).
- meshoptimizer 1.3.0 for Fix model.
- Product photos: honours a store's "try again in N seconds", and falls back to the product's .json data or the
  page's preview picture when a store doesn't offer the usual product data.
- AI spending shows tiny costs (under a hundredth of a cent) instead of rounding them to zero.

## 2.17.1
- Security: updated the `ws` library (used to talk to printers) from 8.18.0 to 8.23.0 to fix two published
  high-severity advisories (GHSA-58qx-3vcg-4xpx, GHSA-96hv-2xvq-fx4p), and `jszip` from 3.10.1 to 3.10.2.
  Found by the repository's new dependency audit.

## 2.17.0
- **Filament screen** (Filament button, top right): the Filament Inventory web page is now part of the app. You can track
  spools, statuses, weigh-ins, locations, labels, a dashboard, manufacturer print settings and U1 Orca presets.
  - Data lives in the app's data folder (`filament\`), with a daily backup for two weeks.
  - Color remix and the what-to-buy check use what's on hand on this screen. The old "Filament Inventory folder"
    setting is only a fallback until you import.
  - **Import from Filament Inventory…** brings in the old page's orders, product photos and (from its downloaded
    backup) every spool.
  - **📷 From screenshot** and **Find missing photos online** use the API key from Settings. The key stays in the
    app; store pages and photos are fetched by the app, so browser restrictions no longer apply.
- No separate Filament Inventory web page any more: the "inventory folder" setting and its import are gone
  (tools/import_filament_inventory.js remains for a one-time move of old data).
- **Demo app** (built by tools/build_release.py --demo): a guided tour with a sample 4-color rocket
  (tools/make_demo_rocket.py, CC0) and a MakerWorld/Bambu version of it, replaying results recorded from the real
  app (preload-demo.js). Nothing is sliced, saved, sent or asked of the AI; a banner says so.
- Orientation options are named by what happens to the model ("Stood upright", "Laid down") instead of "On its
  side" for a model saved lying down.
- Compare slices: "Finest/Fine/Fast/Fastest + recommendations" keep the recipe's own layer height and speeds; the
  AI's layer height no longer overrides them (Finest could come out the same as Recommended).
- Times round correctly (2h 0m, not 1h 60m).
- **AI spending**: every Claude answer is priced from its token counts (list prices, web searches included) and
  kept in ai-spend.json. An "AI" counter in the top bar flashes each request's cost and shows the month's total;
  Settings → AI spending lists this month, the last 30 days and all time, by feature, with the latest requests.
  Optional Admin API key (organizations only): "Check this month on Anthropic" reads Anthropic's own figure for
  the whole account and for this app's key (Usage and Cost Analytics API).
- The guide stays visible and clickable over windows like Color remix and the troubleshooter.
- **Get recommended settings** slices only the original model (the AI needs it). It no longer also slices the
  recommended version for Compare slices; do that in Compare slices when you want it. Sending a print still
  slices on demand.

## 2.16.1
- Source as received (baseline).
