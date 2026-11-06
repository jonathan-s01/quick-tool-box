# Quick Tool Box

Simple, accessible web pages for command line programs on your Mac or home server. Each program gets its own page with a normal form: choose a file, pick options, start, and download the results. Everything runs on your own computers.

It is made screen reader first: real headings, labels and fieldsets, one announcement when a job starts and one when it ends, and results as pages you can move through by heading.

By Jonathan Sieswerda ([jonathan-s01](https://github.com/jonathan-s01)). Free software under the GNU Affero General Public License, version 3 or later (see LICENSE). You may use, change and share it. If you change it and let other people use it over a network, you must offer them your changed source code too.

Your own addresses, passwords and choices go in .env, which is never shared. See "Settings for your network" below.

Included tools:

- Document converter (pandoc): Word, HTML, Markdown, plain text, EPUB, OpenDocument and RTF.
- Hidden file details (ExifTool): shows the hidden details in a file, such as location, camera and author, or makes a cleaned copy without them.
- Image converter (ImageMagick): converts, shrinks, straightens or greyscales images. It can also turn an image into a PDF.
- PDF to images (Poppler): turns PDF pages into PNG, JPEG or TIFF files.
- PDF/UA checker (veraPDF): checks a PDF against PDF/UA-1 or PDF/UA-2 and makes an HTML report with a heading for each failed rule.
- Searchable PDF (OCRmyPDF): adds a hidden text layer to a scanned PDF. The pages still look the same.
- Speech to text (Whisper): makes a transcript (.txt) or captions (.srt, .vtt) from audio or video, using whisper.cpp.
- Smart document reader (Docling): makes an accessible HTML and Markdown version of a PDF or scanned page, with paragraphs in reading order, heading levels, a table of contents, real tables, and footnotes moved to the end. Best for academic papers and badly made PDFs.
- Tesseract OCR: quickly reads the text in a scanned PDF or an image, and gives you a text file and an HTML file. Any existing text layer in a PDF is ignored.
- Text to speech (macOS): turns typed text or a document into an M4A or WAV file, using the voices built into macOS. Mac only.
- Text to speech (Kokoro): turns text or a document into natural sounding MP3, M4A or WAV, using the free Kokoro voice model. Works on the Mac and the server.
- Letters and bills reader: turns a bill, statement or letter into a page with a summary at the top (amount owing, due date, what to do) and the full document below.
- Find in a document: search a tax return, T4 slip, statement or form for a line number, box number, amount or words, and get the amount that goes with it. 15000, 15,000 and line 15000 all work. Several ways of reading the page.
- Describe an image: a local AI model describes a photo or screenshot, reads the text in it, and answers follow-up questions.
- Video and audio download (yt-dlp): downloads a video, just its audio, or just its captions. Only download things you have the right to.
- Redactor: finds private information in a document (social insurance, card, bank, account and ID numbers, names, addresses, birth dates, phone numbers, email addresses). You untick anything to keep, and get back a PDF with the rest truly removed.
- Menu reader: turns a menu from a web page, a PDF or a photo into a simple page: restaurant, then categories, then dishes with price, description and tags. Menus can be saved and downloaded.
- Whisper model download: gets the speech models the Speech to text tool needs.

Also included, and optional: Bus times, a small page with scheduled and live bus times for Edmonton (ETS) stops. See Bus times below.

Other pages: Profile and My forms (encrypted personal profiles and the form filler), Saved menus, and Status (is everything working).

## Setup

You need Node.js 20 or later, and Homebrew. There are no npm packages to install.

1. Install the programs. In Terminal, run:

   brew install tesseract tesseract-lang poppler imagemagick ocrmypdf pandoc exiftool ffmpeg whisper-cpp yt-dlp

   tesseract-lang adds French and other OCR languages. You can leave out any tool you do not want; its page will say what is missing.

2. For the PDF/UA checker:
   - Install Java: brew install --cask temurin
   - Download the veraPDF installer from verapdf.org (Software, then Download), run it, and keep the suggested install folder (verapdf in your home folder).

3. For Speech to text: brew install whisper-cpp ffmpeg (on the home server it is already built in). Then start the app, open Whisper model download, and download a model. small.en is a good start for English. large-v3-turbo-q5_0 is better for French or mixed languages. Models are saved in a folder called whisper-models in your home folder, so they are kept when you update this app.

4. For the Redactor: brew install uv ocrmypdf. PyMuPDF is downloaded automatically by uv the first time. For Word files, also install LibreOffice: brew install --cask libreoffice
   For Text to speech (Kokoro): Docker Desktop (or another way to run Kokoro-FastAPI) and ffmpeg: brew install ffmpeg
   For the Menu reader: Google Chrome (or Chromium) and an Ollama model, for example: ollama pull qwen3:8b

5. For the Smart document reader:
   - brew install uv
   - uv tool install docling --with ocrmac
   The first document you read downloads Docling's layout models, which takes a few minutes. ocrmac lets Docling use the OCR built into macOS (Apple Vision).

6. For AI clean-up (in the Smart document reader and Tesseract OCR): install Ollama (brew install ollama, or the app from ollama.com), start it, and download a vision model:
   - ollama pull qwen3-vl:8b (about 6 GB, a good start)
   - ollama pull qwen3-vl:30b (about 20 GB, more accurate, fits in 48 GB of memory)
   Any Ollama model that can read images shows up in the Model list.

7. Text to speech needs nothing extra.

8. Unzip this folder somewhere, for example in your Documents folder. To update to a new version, replace the folder. Nothing in it needs to be kept.

## Starting and stopping

1. In Terminal, go to the folder, for example: cd ~/Documents/quick-tool-box
2. Run: npm start
3. Your browser opens at http://localhost:3210

To stop it, go back to Terminal and press Control+C.

If a program is missing, its page has a "Setup needed" heading with the exact install command. Optional extras, such as French for OCR, are listed under an "Optional extras" heading. After installing something, reload the page. You do not need to restart the server.

## Using a tool page

- The form is under the "Start a job" heading.
- When a job starts, your screen reader says "Started" once. When it ends, it says "Finished", "Failed" or "Cancelled" once. Nothing else is announced.
- The progress bar is under the "Current job" heading, and is not announced. The text below it says things like "3 of 12 pages done".
- The "Cancel job" button is right after the progress bar while a job runs.
- When a job finishes, a short result is shown above the downloads, for example "PDF/UA-1 check failed: 3 rules".
- Download links are under the "Downloads" heading. Each link says what the file is, its name and its size. Reports, text and caption files also have an "Open in a new tab" link right after, so you can read them without saving.
- Reports made by the tools (veraPDF, ExifTool, OCR HTML) use headings, so you can move through them by heading.
- If a job fails, a "Technical details" section shows the program's error output.
- The browser tab title starts with "Running", "Finished", "Failed" or "Cancelled", so you can check on a job from another tab.

## AI clean-up

AI clean-up fixes OCR mistakes, such as 1 read instead of l, or rn instead of m.

- Each paragraph is sent to the model with a picture of that part of the page, so it checks against what is printed rather than guessing.
- Everything runs on your own computers, through Ollama on a Mac or the AI models on your server. Nothing is sent to the internet.
- "What kind of text is it" sets how much the AI may change. 10 is plain prose, where anything that is not a normal word gets fixed. 1 is very technical text, where only obvious mistakes in ordinary words are fixed.
- The AI's answer is checked word by word before it is used. A change is only applied if it looks like an OCR fix. The AI can never add words, remove words, or rewrite a paragraph, and it can only change a number at strictness 9 or 10.
- For English, each change is checked against the word list built into macOS:
  - Not a word becoming a word (tbe to the) is trusted most.
  - A real word becoming a different real word (form to from) needs strictness 8, or 5 if the OCR was unsure about the word. Look-alike swaps such as l to I need less.
  - A real word becoming a non-word is never applied.
  - Words not in the dictionary (names, jargon) and abbreviations (TCP, mRNA) are left alone at lower settings.
  The macOS list has few plurals and verb endings, so common endings such as -s, -ed and -ing are removed before looking a word up.
- Tesseract OCR also says how sure it was about each word. The AI is told which words were unsure, those words can be changed more freely, and words Tesseract was sure about need much stronger evidence. The Smart document reader does not get these scores, so all its words are treated the same.
- Every change is listed in a separate AI changes report, by page, with the words around it. Suggestions that were not applied are listed too, with the reason.
- It adds a few seconds per paragraph, so a 30-page paper can take 10 minutes or more. The progress bar counts paragraphs.

## Redactor

1. Choose the document. PDFs, scans, photos, and Word, OpenDocument, RTF and text files all work. You always get a PDF back.
2. Optional: under "Always look for these", type things you always want found, one per line, such as your name or address. This is kept in your browser on that device only, and filled in next time.
3. Choose Find private information. Scanned pages get a hidden text layer first (OCRmyPDF), so their text can be found.
4. When it finishes, the Found items heading lists everything found. Each group (Social insurance numbers, Names and so on) is a fieldset, and each item is a checkbox with the text, how many times it appears, the pages, and the words around it. Everything is ticked except "Other dates", because most dates on a tax slip are not private.
5. Untick anything to keep. Optionally type other text to remove. Choose Make redacted PDF.

How it removes things:

- The text under each black box is deleted from the file, not just covered. The old text is also thrown out of the file when it is saved, so it cannot be recovered.
- On scans, the picture itself is blacked out under each box.
- Answers typed into fillable form fields are cleared if they hold removed text.
- Comments and document details (such as Author) that contain removed text are cleared.
- Everything else is untouched: the rest of the text layer, fonts, lines and form boxes stay, so the document still looks official and a screen reader can still read it.
- If "Write what was removed" is on, each box gets a small white label such as "SIN removed". Your screen reader reads these labels where the text used to be, which is a quick way to check the result. Very small boxes get no label.
- After saving, the new PDF is opened again and searched for every removed item. The result message says "Check passed", or warns you and lists anything that can still be found.

How things are found:

- Numbers, email addresses, phone numbers, postal codes, dates and most street addresses are found with patterns. Social insurance numbers and card numbers are checked with the check digit they use, so most random numbers are not listed.
- Names, and addresses the patterns miss, are found by an AI model in Ollama, one page at a time. Nothing is sent to the internet.
- No automatic search is perfect. Always skim the result before sharing it.

## Menu reader

Give it a web address, or a PDF, photo or saved web page. You get a page with:

- Heading level 1: the restaurant name and "menu".
- Heading level 2: each category, in the menu's order.
- Heading level 3: each dish.
- Under each dish, one line: price, description, then tags such as Vegetarian or Spicy, each ending in a full stop so your screen reader pauses. Sizes and add-ons are kept with their prices.

Notes:

- Web pages are opened in a hidden Chromium browser, because many restaurant sites build their menu with scripts. If the page has few prices but links to a PDF menu, the PDF is used. If the menu is only pictures, the pictures are read with OCR.
- For photos, "Read the text with Tesseract" is fastest. "Let the AI model look at the photo" copes better with columns and fancy fonts, but needs a model that can read pictures and is slower.
- Leave "Save to my menu library" ticked to keep it. Saved menus has a heading for each menu, with links to read it, download it, and a Delete button.
- The AI only copies what is on the menu, but it can still make mistakes, so check prices before ordering if it matters.

## Profiles and the form filler

Go to Profile in the top navigation.

Profiles:

- Each profile (for example one for each person in your home) has its own password. When you make one, you get a recovery code once. Save it: if you forget the password, it is the only way in. "Forgot the password" on the Profile page uses it to set a new password.
- Everything in a profile is encrypted: your details, your signature, the forms you upload, your answers and the filled PDFs. The password and recovery code are never stored. Technically: a random key per profile, AES-256-GCM, and the key is locked with scrypt from your password and from your recovery code.
- After unlocking, the profile stays unlocked in that browser only. It locks after 15 minutes without use, with Lock now, or when the server restarts.
- After 5 wrong passwords, you have to wait before trying again, and the wait gets longer.
- Edit my details has a fieldset for each group (name, birth and identity, contact, address, spouse, dependants, work, banking, emergency contact) and a box for your own items, one per line, such as Student ID: 1234567.
- Set REQUIRE_LOGIN=1 to make every page need an unlocked profile.

Your signature:

- My signature takes a photo or scan of your signature on paper, or a black on white image. It evens out shadows, removes the paper, makes the background see-through, crops to the ink, and tells you if the background was not fully removed.
- It is never added on its own. Each form lists every place to sign, with the words above it that you are agreeing to, and you tick each one.

Filling in a form:

1. My forms, choose the file, Read the form. PDFs work best. Pictures and Word files are turned into a PDF first.
2. The form page starts with a count: questions, filled from your profile, already filled on the form, empty, required, places to sign.
3. Each section of the form is a heading, with the form's instructions for it under the heading. Each question is a real form control with the form's own wording as its label. Under each one: where the answer came from (your profile, matched by AI, already on the form), the wording near it, the date format, the length limit and the page.
4. Already on the form lists answers someone else typed, pictures, drawn ink and comments, with the nearest label, for example "near: Witness signature". Read handwriting and pictures with AI sends a picture of each one to a vision model in Ollama and adds what it reads. You cannot change these, only read them.
5. Signatures: each place to sign is a fieldset with "What you are signing" and a Sign here checkbox. A date next to it is filled with today's date if empty.
6. Save answers keeps a draft. Make filled PDF saves, fills the PDF and checks it.

What the check does:

- Your answers are added on to the end of the original file (an incremental save), so the original is still there byte for byte. The check confirms this.
- Every page of the original and the filled PDF is drawn as a picture and compared. Any change outside your answers and signatures fails the check and lists the page.
- Every answer is read back from the new file and compared with what you typed.
- Required questions that are still empty are listed.
- Open a summary of every question and answer gives a page with each section as a heading and each question and answer, to skim before sending.
- After that, Save answers to your profile offers new or changed answers, ticked only when the profile item is empty.

Kinds of forms:

- Fillable PDFs work best. Only the field answers change.
- Forms without fields (printed-style): blanks are found from lines, underscores and boxes, and your answers are written on top in those places. Check these, because a blank can be missed.
- XFA forms (Adobe-only, common on federal forms): the page explains what that means. If the form also has normal fields, you can choose Remove the XFA part. That changes the file, keeps the original, and the check then compares against the changed file. Forms that are only XFA cannot be filled.

AI and privacy: matching questions to your profile uses rules first. "Also use AI to match questions" sends only the wording of the questions, never your answers, to Ollama on your own computer or server. Choose models with FORM_TEXT_MODEL and FORM_VISION_MODEL, otherwise the first one found is used.

## Text to speech (Kokoro)

Turns typed text or a document into an audio file with Kokoro, a free voice model (Apache 2.0 licence) that runs on an ordinary processor. It works on the home server and on the Mac. On the Mac, the older Text to speech tool with the macOS voices is still there too.

- Documents: text, Markdown, PDF (with a text layer; run scanned PDFs through OCR first), Word (.docx), OpenDocument, RTF, EPUB and HTML.
- Voice: the list comes from the Kokoro server, labelled by name, language and female or male, for example "Heart, American English, female". Each voice speaks its own language best. Kokoro cannot copy a voice from a recording.
- Speed: from 0.7 to 2 times normal.
- Format: MP3, M4A or WAV.
- Long texts are split at sentence ends into pieces of about 1,500 characters, spoken one at a time with progress shown ("Speaking part 3 of 40"), then joined into one file with ffmpeg.

Starting the Kokoro server:

- Home server: it is in docker-compose.yml as the kokoro service, so docker compose up -d starts it. It only listens on the server itself. The first start downloads the model.
- Somewhere else, for example another computer or a Mac: run the Kokoro-FastAPI Docker image there and add KOKORO_URL to .env with its address, for example http://192.168.1.21:8880 or its Tailscale name.
- Without Docker: see the Kokoro-FastAPI project (github.com/remsky/Kokoro-FastAPI) for other ways to run it.

Speed on your hardware: Kokoro is small, so on a CPU it normally makes audio faster than real time. Older processors are slower than the ones in published tests, but still fine for documents. If the AI models are busy on the same computer at the same time, both slow down.

### Bigger voice models for an Apple Silicon Mac

These sound better or can do more than Kokoro, but are too heavy for the server's CPU. They suit an Apple Silicon Mac with plenty of memory. They are not built into Quick Tool Box yet; these notes are for trying them first. Check each project page for current install steps, because these projects change quickly.

- Chatterbox (Resemble AI, MIT licence). Very natural, and can copy a voice from a 5 to 20 second clip, including your own. In the makers' blind tests, listeners preferred it over ElevenLabs. Newer versions cover over 20 languages. Every file it makes has a hidden watermark. Good for: long reading in a voice you like, or your own voice. Python package: chatterbox-tts.
- Qwen3-TTS (Apache 2.0). Several languages, voice copying, and you can describe the voice you want in words, such as "calm older male narrator". Good for: trying voices without recordings.
- Kokoro on the Mac. Kokoro-FastAPI has a version for Apple Silicon, which is much faster than the server CPU. If you run it on the Mac, point KOKORO_URL on the server at the Mac's Tailscale address and the tool uses it, as long as the Mac is awake.
- Also worth watching: F5-TTS and Fish Audio (good voice copying, but check the licence; some are for non-commercial use only), and Piper (lower quality than Kokoro, but tiny and very fast, in case Kokoro is too slow on the server).

If one of these works well for you, it can be added as another engine in this tool, the same way Ollama runs on the Mac and is used from the server.

## Status page

Status, in the top navigation, checks everything in one place: free disk space and memory, which programs are installed, each Ollama (the Mac and the server) with its models and which one is in use now, the Kokoro voice server, the Docling server, and a list of tools that still need setup with the reason. Reload the page to check again.

## AI models: the server and the Mac

Every AI tool uses the first of these that answers (checked every 20 seconds):

1. A Mac's Ollama, if you set LLM_MAC_URLS in .env. Each address is tried in turn, for example Ethernet, then Wi-Fi.
2. The server's llama.cpp, through llama-swap (LLM_SERVER_URL; by default http://localhost:8091).

Model lists on tool pages come from whichever is in use. If you chose a model on a page and that computer then went to sleep, the best model on the other one is used instead, and AI-written pages say which model and computer actually answered.

### The server: llama.cpp with llama-swap

llama.cpp runs the models; llama-swap starts it with the model each request asks for, switches models when another is asked for, and unloads a model after 15 minutes without use (LLM_TTL) to give the memory back. Only one model is loaded at a time.

Why llama.cpp instead of Ollama on the server: Ollama runs the same engine underneath, so the speed difference on one user is small, typically under 10 to 20 percent. The real gains are control: setting the exact number of threads for this container, choosing any GGUF model from Hugging Face, and seeing exactly what runs.

Models: ./models.sh. With no options it shows a menu of installed and suggested models. Suggested:

- Qwen3 VL 4B (recommended, installed by ./setup.sh): reads text and sees images, so one model covers every tool with no switching. About 3.3 GB.
- Qwen3 4B 2507: text only, quick. Qwen3 8B: better writing, about half the speed.
- Qwen3 VL 8B, Gemma 3 4B: other models that see images. Newer ones (Qwen3.5 4B, Gemma 4 E4B) are listed too; they are checked on Hugging Face when you add them.
- Any GGUF model: ./models.sh add REPO:QUANT, for example ./models.sh add unsloth/Qwen3-8B-GGUF:Q4_K_M

Models are saved in llm/models, and the list in llm/models.json. llama-swap is restarted by itself after a change. Downloads that stop can be continued by running the same command again.

Tuning, worked out by ./setup.sh and kept in .env:

- LLM_THREADS: threads for writing the answer. Writing is limited by memory speed more than by cores, so more threads stop helping after a point. With everything on one computer, one core is left for the other services.
- LLM_THREADS_BATCH: threads for reading the prompt (and pictures), which does use every core.
- LLM_CTX: how much text the model can hold at once, in tokens. 8192 is enough for a long letter or a page with a picture.
- LLM_RAM_GB: memory set aside for models; ./models.sh warns if a model will not fit.

To find the best number of threads for your computer: ./models.sh bench shows how many tokens per second it reads and writes. Change LLM_THREADS in .env, run ./models.sh config (which restarts llama-swap), run ./models.sh bench again, and keep the fastest. For example, on a 6-core computer try 4, 5 and 6. ./setup.sh --retune puts the suggested values back.

For speed: in Proxmox, set the container's CPU type to host (so llama.cpp can use AVX2), and avoid swap for this container; a model that does not fit in memory becomes very slow.

llama-swap also has its own page at http://SERVER:8091/ui with the loaded model, logs and speed of each request.

### Speed on the server

The server has no graphics card, so every answer is worked out by the processor. Two things take time:

- Reading the request, including pictures and any document. A picture or a long page can take a minute or more.
- Writing the answer, a few words per second. Bigger models write slower.

What helps:

- Small models for quick things. Qwen3 1.7B (installed by ./setup.sh) or Llama 3.2 3B answer in seconds; 4B models take tens of seconds; 8B is slow. Pick the model per chat in Open WebUI.
- ./models.sh tune: tries different numbers of threads and keeps the fastest (about 5 minutes). Run it again after changing the container's cores. ./setup.sh offers it.
- In Proxmox, CPU type host. Fewer threads than the computer has can be faster: on a processor with 6 real cores and 12 threads, 6 is often best, because two threads on one core share it.
- One AI job at a time. Quick Tool Box queues its own AI requests, and the page says "Waiting for the AI model" and then shows progress (reading, then words written). Open WebUI is separate, so avoid using both at once.
- Pictures are shrunk before they are sent to the server (LLM_IMAGE_MAX, default 1024 pixels; 1400 for menus). The Mac gets full size.
- A laptop used as a server slows down when it gets hot. Keep it cool and on power.

Open WebUI sends extra AI requests after each message (titles, tags, suggested follow-ups, autocomplete). New installs have these off. On an existing install, turn them off in Admin Panel, Settings, Interface. Under Web Search, leave search off unless you need it in that chat.

### The Mac

Ollama installed with Homebrew only listens to the Mac itself. To let the server use it:

1. Copy mac/ollama-network.sh to the Mac.
2. In Terminal: bash ollama-network.sh

It stops Homebrew's service and any "ollama serve" you started by hand, then makes Ollama start by itself at login, listening on your network. If the macOS firewall is on, it lets Ollama through (it may ask for your Mac password). It ends by saying whether it worked and listing the Mac's addresses. To undo: bash ollama-network.sh --undo

Check from the server: curl http://MAC-ADDRESS:11434/api/version, using an address the script listed. An answer like {"version":"..."} means it works.

If you also installed the Ollama app from ollama.com, quit it and remove it from login items, so only one copy runs.

Using the Mac's models on the Mac itself, nothing else needed:

- ollama list: your models.
- ollama run qwen3:8b: chat in Terminal. Type, press Return, and the answer is printed. /bye to leave. Add a question to get one answer and go back to the prompt: ollama run qwen3:8b "explain this error".
- ollama pull NAME and ollama rm NAME: add and remove models.
- Open WebUI on the server also lists the Mac's models whenever the Mac is awake, which is easier to read with VoiceOver than Terminal.

Suggested for a Mac with 48 GB of memory or more: qwen3-vl:30b (sees images, very good) and qwen3:30b (text).

## Letters and bills reader

Choose a bill, statement or letter: a PDF, or a photo or scan of paper. Docling reads the layout, including tables of charges, then a local AI model writes a summary. The result is one page:

- Heading 1: what it is, for example "Bill from EPCOR Utilities, October 10, 2026".
- Heading 2, Summary: from, about, amount owing, due date, account number, date of the document and contact, as a list. Then Heading 3 sections: What you need to do, Other important dates, Amounts.
- Heading 2, Contents (for long documents), then Heading 2, Full document, with the document's own headings as Heading 3 and below, and real tables with column headers.

The summary is checked against the document: an amount, date or account number that does not appear in the document word for word is marked "not found word for word in the document; check it". The model is told to copy values and never calculate. The finish message also gives the amount and due date, so you hear them straight away. Nothing is read aloud.

On the home server, Docling runs as its own container, in docker-compose.yml. On the Mac, the installed Docling is used if there is one. The Smart document reader also uses the Docling server when Docling is not installed, so it works in Docker too.

## Find in a document

For finding one value in a long document without reading the whole thing: line 15000 on a T1 return, box 14 on a T4 slip, or an amount on a statement.

1. Choose the document: a PDF (fillable forms too), a scan or photo, or a Word, OpenDocument, RTF or text file. Optionally type something to search for straight away, and choose how to read the page.
2. When it has been read, follow the link to the search page. From an iPhone share, it opens by itself.
3. Type a line number, box number, amount or words, choose how to read the page, and choose Find. Search as many times as you like.

### Ways of reading the page (modes)

You can switch between these on the search page. The last one you used is remembered for that document.

- Automatic: tries lines and boxes together and lists the best answers first. Short numbers (1 to 3 digits, like 14) lean towards boxes; longer ones (like 15000) lean towards lines. If neither finds anything, it falls back to Nearby.
- Lines, for tax returns: the label, line number and amount are on one line, left to right, as on the T1. Search 15000 to get "Total income, line 15000" and its amount.
- Boxes, for slips such as T4, T5 and receipts: finds the box number, then the amount in the same drawn box, beside it on the same line (stopping at the next box number), or directly below it. The label is taken from the same box or the line just above. Search 14 or box 14 to get "Box 14, Employment income" and its amount. Search an amount, such as 9876.54, to be told which box it is in. It uses the box outlines drawn in the PDF and the outlines of form fields, when there are any.
- Nearby: for odd layouts. For each match it lists the nearest text to the right, below, to the left and above.

Each result ends with how it was found, for example "Found as a box, with the amount beside it", so you can tell which mode gave it.

### What you get

After a heading Results with the number of matches and the first answer (focus moves there, so it is read first):

- A heading for each match, for example "Page 1: Box 14, Employment income" or "Page 1: Total income, line 15000".
- A list: the amount, the whole line (parts separated by semicolons), the line above and the line below (or, in Nearby, right, below, left and above), how it was found, and a link to read that page line by line starting from that line.
- If nothing matches exactly, lines that are close are listed, for example 15000 inside 150000.

How numbers are matched: 15000, 15,000, 15 000, 15000.00, $15,000 and French 15 000,00 are all the same number, and "line 15000", "box 14" or "ligne 15000" work too.

### Scans and photos

Pages without a text layer are read with OCRmyPDF. Choose how, before reading the document:

- Row by row (the default): best for tax returns and statements. It finds numbers in the amount boxes of a T1.
- Automatic layout: often best for slips with small numbered boxes, such as a scanned T4, and for letters.
- Scattered text: finds small numbers on busy pages, but loses some of the line order.

If box numbers or amounts are missing, read the document again with another choice. In testing, row by row missed the small box numbers on a scanned T4 that the other two found. OCR also reads box borders as brackets, which are removed, and can still misread small digits (16 read as "xs"), so check important numbers against the document.

Privacy: the document's text is kept only in the server's memory (RAM). At most 20 documents are kept; each is forgotten an hour after you last searched it, when the server or container restarts, or when you choose Forget this document now. The uploaded file is deleted as soon as it has been read.

## Describe an image

Choose a photo or screenshot, optionally with a question. A vision model describes it (short, normal or detailed), copies every piece of text in it, and answers your question. Then an "Ask about this image" box appears: each question is answered in the finish message and added to the description page under Questions and answers. Follow-up questions keep working until the job expires an hour later.

## Sharing from the iPhone (Shortcuts)

Any tool can be started from the share sheet. The shortcut sends what you shared to the server, and Safari opens on the tool's page, which follows the job. When it finishes, the result page opens by itself for tools that make a page, such as the Letters and bills reader and the Menu reader. Describe an image stays on the tool page, so you can ask follow-up questions. For tools that make files, such as text to speech, the download links are shown.

Make one shortcut per tool. In the Shortcuts app:

1. New shortcut. Open its settings (the i button or the name at the top) and turn on Show in Share Sheet. Set what it receives:
   - Letters and bills reader: Images and PDFs.
   - Describe an image: Images.
   - Find in a document: Images and PDFs. TOOL is find. Add a Text field named q with Ask Each Time to type the search when you share.
   - Menu reader: URLs, Safari web pages, Images and PDFs.
   - Text to speech (Kokoro): Text and Safari web pages.
2. Photos only: add Convert Image, to JPEG. iPhone photos are HEIC, which the server may not open.
3. Text to speech from Safari only: add Get Article using Safari Reader, then Get Text from Input, so only the article is read and not the menus and ads.
4. Add Get Contents of URL. Set:
   - URL: http://YOUR-SERVER:3210/api/share/TOOL, where TOOL is letters, describe, menu or kokoro. Use the address you normally use for the tools, for example your Tailscale name.
   - Method: POST.
   - Headers: add one, key X-Quick-Tool-Box, value share.
   - Request Body: Form. Add a field named file, type File, set to Shortcut Input (or the converted image). For the Menu reader with a link, name the field url and make it Text. For text to speech, name it text and make it Text.
   - To give other settings, add more fields named like the setting. For example question for Describe an image, or voice and speed for text to speech.
5. Add Open URLs. It uses the result of Get Contents of URL, which is the address of the job page.

If something is wrong (no file, a tool that needs setup), Safari opens a page that says what happened.

Safety: a share must carry the X-Quick-Tool-Box header, which a web page on another site cannot send, and it still only works from your home network and tailnet. If you turn on REQUIRE_LOGIN, also set SHARE_TOKEN to a long random value and add a second header to each shortcut, X-Share-Token, with that value.

## Running on a home server

Everything runs in Docker on Debian or Ubuntu, for example in a Proxmox LXC.

### Setup in one step

1. Make the LXC. In Proxmox, Options, Features: tick Nesting and keyctl. Set the CPU type to host. Give it the memory and disk below.
2. Copy this folder to it, for example into /opt/quick-tool-box.
3. Run, as root: ./setup.sh

setup.sh does the rest:

- Installs Docker if it is missing, and checks that it can run containers (with a clear message if Nesting or keyctl is off).
- Looks at this computer (cores, memory, disk, AVX2) and writes .env with the tuning, two secrets, and the Mac's addresses.
- Makes the folders: data (Quick Tool Box), open-webui (chats), documents (for Open WebUI), llm (models).
- Offers to download the recommended model (yes by default).
- Downloads and starts every container, waits until each one answers, and prints the addresses to use.

Run it again at any time, for example after an update: it keeps .env, data and models. ./setup.sh -y answers every question with the suggested answer.

What runs, and where:

| Service | What it is | Address |
| --- | --- | --- |
| quick-tool-box | These tools | http://SERVER:3210 |
| open-webui | Chat | http://SERVER:8080 |
| llama-swap | AI models (llama.cpp) | http://SERVER:8091/v1 (and /ui) |
| kokoro | Voices | only on the server |
| docling | Document reader | only on the server |
| searxng | Web search for Open WebUI | only on the server |

Use the server's home network address or its Tailscale name. To check on things: the Status page, docker compose ps, and docker compose logs -f NAME.

### Speech to text on the server

The container includes whisper.cpp, built from source the first time the container is built (this adds a few minutes to the first ./setup.sh). It is built for the processor of the computer that builds it. Open Whisper model download and get a model; models are saved in data/whisper-models, so they are kept across updates. base.en or small.en are good choices for a processor without a graphics card; the large models are slow there.

### Settings for your network

Everything that is specific to your home, such as addresses, allowed networks, the Mac's Ollama and your time zone, is kept in .env. ./setup.sh makes it from .env.example and asks for what it cannot work out. .env.example explains each setting. Because .env is in .gitignore, it is never uploaded if you keep your copy in Git.

### One container or two

Everything can run in one container with about 14 GB of memory and 6 cores (the default, ./setup.sh). If memory gets tight, split it across two computers or containers:

- On the one with the faster processor: ./setup.sh --role llm (only the models; all its threads go to llama.cpp).
- On the other: ./setup.sh --role apps --llm-server http://AI-COMPUTER-ADDRESS:8091

Rough memory use while busy: the Qwen3 VL 4B model 4 to 5 GB (an 8B model 6 to 7 GB), Docling 2 to 4 GB, Open WebUI 1 to 2 GB, Kokoro about 1.5 GB, Quick Tool Box up to 1 GB. So all-in-one with a 4B model fits in 14 GB; with an 8B model, split them.

Integrated graphics do not speed up llama.cpp much, so put the models on the computer with the fastest processor.

### Disk size

You can make the container smaller than 80 GB:

- Container images: about 15 to 20 GB (Open WebUI, Docling and Kokoro are the big ones).
- Models: 3 to 4 GB each for 4B models, 5 to 6 GB for 8B.
- Open WebUI's data: 1 to 3 GB plus your documents. Docling and Open WebUI also download their own helper models the first time.
- Updates: new images download before old ones are removed, so leave 10 GB spare, and run docker image prune after updates.

All-in-one with two or three models: 50 GB is comfortable, 40 GB is the minimum. Split: about 25 GB for the models container and 40 GB for the apps container. Proxmox cannot shrink a container's disk in place; recreate it, or restore a backup with a smaller disk size.

### Updating

- Quick Tool Box: replace the folder's files (keep .env, data, open-webui, documents, llm and searxng/settings.yml), then run ./setup.sh again.
- The other containers: docker compose pull, then docker compose up -d. Then docker image prune to remove old images.

### Who can connect

- Quick Tool Box and Bus times check the address of every visitor against ALLOWED_NETWORKS in .env. ./setup.sh suggests this computer, your home network and Tailscale. If it is empty, all private home network ranges and Tailscale are allowed, and nothing from the internet. If you use a reverse proxy, its address must be in an allowed range.
- It also checks the name in the address bar, to block other websites. IP addresses on the allowed networks, Tailscale names and localhost always work. Add other names, like your reverse proxy name, to ALLOWED_HOSTNAMES.
- Profiles and forms need the profile password. The other tools are open to your home network and tailnet unless you set REQUIRE_LOGIN=1.
- Open WebUI has its own accounts. The first account you make is the administrator.
- llama-swap (port 8091) has no password: anyone on your network or tailnet can use the models. That is what lets Home Assistant use them. Set LLM_BIND=127.0.0.1 in .env to keep it on this computer only.
- Open WebUI (port 8080) is a separate program and does not use ALLOWED_NETWORKS. It has its own accounts instead. Do not make it reachable from the internet.
- Every container's log is capped at 30 MB.

## Chat with Open WebUI

Open WebUI is for everyday chat: switching between models, chatting with your documents, web search, and workspaces (saved custom models with their own instructions, prompts and knowledge).

How docker-compose.yml sets it up:

- Models: the server's llama.cpp models, plus the Mac's Ollama models (Ethernet and Wi-Fi addresses) when the Mac is awake, all in one model list.
- Documents: read by the Docling container, then searched with the search model built into Open WebUI.
- Web search: through the SearXNG container, so no outside search account is needed. Turn it on per chat with the Web Search button.
- Read aloud: uses the Kokoro container.

These settings only apply the first time Open WebUI starts. After that, change them in Open WebUI under Admin Panel, Settings; editing docker-compose.yml or .env does not change them.

Tips:

- Admin Panel, Settings, Interface: set the Task Model to a small model, so chat titles and search queries do not slow down your main model.
- Screen reader support in Open WebUI has had gaps, such as replies not being announced. If you find problems, report them to the Open WebUI project.

### Documents for Open WebUI

Put files in the documents folder on the server. Each folder inside it becomes a knowledge collection with the same name (files directly in documents go into "Documents"). In a chat, type # and choose a collection; in a workspace model, add a collection as its knowledge so it is always used.

To copy the folder into Open WebUI:

1. In Open WebUI: Settings, Account, API keys, make a key. If there is no API keys section, turn it on in Admin Panel, Settings, General.
2. Put it in .env as OPEN_WEBUI_API_KEY.
3. Run ./docs.sh. It adds new and changed files and takes out files you deleted. Run it again after changes.

To run it every hour by itself: crontab -e, and add a line like this (with your folder):

0 * * * * /opt/quick-tool-box/docs.sh >/dev/null 2>&1

docs.sh uses Open WebUI's documented file and knowledge API. It has not been tested against a running Open WebUI yet; if it fails, the message says which step. You can always drag files into a knowledge collection in Open WebUI instead (Workspace, Knowledge).

## Home Assistant

Home Assistant runs elsewhere and only needs an address and a model.

For fast answers on the always-on server:

1. Use a small model: qwen3-1.7b (installed by ./setup.sh) or llama3.2-3b (./models.sh add llama3.2-3b).
2. In Home Assistant, add a conversation agent that can use an OpenAI-compatible address. The built-in OpenAI integration cannot change its address, so use a community integration from HACS that can. Give it http://SERVER:8091/v1, any API key (for example none), and the model name, such as qwen3-1.7b. Follow that integration's own instructions; they change.
3. In Settings, Voice assistants, your assistant: choose that agent, and turn on Prefer handling commands locally. Then "turn on the kitchen lights" is done by Home Assistant itself in a moment, and only other questions go to the model.
4. Expose only the devices you want the model to know about. Every exposed device is text the model has to read with each request, which is the slow part here. The server keeps the start of the last request, so the second question in a row is quicker.

A Mac running Ollama, when awake, is much faster: the built-in Ollama integration with http://MAC-ADDRESS:11434 and a model such as qwen3:8b.

## Bus times (Edmonton)

A small page for Edmonton Transit Service (ETS) bus stops: saved stops with nicknames, the next buses with scheduled and live estimated times, stop search, and routes. It only works for Edmonton, so it is optional.

- Turn it on: answer yes when ./setup.sh asks, or add bus to COMPOSE_PROFILES in .env (for example llm,apps,bus) and run ./setup.sh again.
- It runs at http://SERVER:3220 (BUS_PORT in .env) and uses the same ALLOWED_NETWORKS as Quick Tool Box. It has no login.
- Details, reverse proxy setup and how the times are worked out: bus-times/README.md.
- Data: schedule and live times from the City of Edmonton's open data; address search from OpenStreetMap (Nominatim), © OpenStreetMap contributors.

## Privacy and safety

- On a Mac, the server only accepts connections from this computer. On a server, it only accepts the networks listed above. It always blocks requests from other websites.
- Programs are run directly, never through a shell, and every option is checked against its allowed values. Text typed into a form can never run as a command.
- Files you open in a new tab are shown in a locked-down mode: no scripts and nothing loaded from the internet.
- Uploaded files go in a temporary folder. The upload is deleted as soon as the job ends. Results are deleted an hour after the job ends, and everything is deleted when you stop the server.

## Settings

- Use a different port: PORT=4000 npm start
- Do not open the browser automatically: NO_OPEN=1 npm start
- Keep Whisper models somewhere else: WHISPER_MODELS=/path/to/folder npm start
- Use a different English word list for AI clean-up: DICT_FILE=/path/to/words.txt npm start (one word per line)
- Listen on the network instead of only this computer: HOST=0.0.0.0 npm start (see Running on a home server for ALLOWED_NETWORKS and ALLOWED_HOSTNAMES)
- Keep saved menus somewhere else: DATA_DIR=/path/to/folder npm start (default: quick-tool-box-data in your home folder; an existing quick-tool-box-data folder is still used)
- Use a specific browser for the Menu reader: CHROMIUM_PATH=/path/to/chrome npm start
- Use a specific Python for PyMuPDF: PYMUPDF_PYTHON=/path/to/python3 npm start
- Use a Kokoro voice server somewhere else: KOKORO_URL=http://192.168.1.21:8880 npm start (default http://localhost:8880)
- Require an unlocked profile for every page: REQUIRE_LOGIN=1 npm start
- Choose the AI models for forms: FORM_TEXT_MODEL=qwen3:30b FORM_VISION_MODEL=qwen3-vl:30b npm start
- How many jobs may run at once (others wait): MAX_JOBS=2
- Biggest upload, in MB: MAX_UPLOAD_MB=1024
- Where jobs keep their temporary files: WORK_DIR=/path/to/folder
- AI servers: LLM_MAC_URLS (Mac Ollama addresses, comma separated, tried first) and LLM_SERVER_URL (llama-swap). Older settings OLLAMA_MAC_HOST and OLLAMA_HOST still work.
- Docling server: DOCLING_URL=http://localhost:5001
- Require a token for iPhone shares: SHARE_TOKEN=a-long-random-value
- Mark the profile cookie as HTTPS-only, if you use HTTPS through a reverse proxy: SECURE_COOKIES=1

## Checking after changes

npm run check checks that every file parses, starts the server on a spare port with a temporary data folder, opens every page, tries the safety checks on posts and shares, and makes and opens a test profile. It does not need Ollama, Kokoro or Docling. Run it after changing any code.

## Adding a tool

Each tool is one file in the tools folder. The server loads every .js file there when it starts. The form, file upload, progress bar, announcements and downloads are shared, so a new tool only describes its options and the commands to run.

Option types are select, checkbox and number. Options with the same group are put together in a fieldset, with the group as its legend. Submitted values are checked against the options before the tool runs.

Example, a tool that turns a PDF into plain text using the PDF's own text layer:

```js
import path from 'node:path';
import { which, missing } from '../lib/system.js';

export default {
  id: 'pdf-to-text',
  name: 'PDF to text',
  summary: 'Copy out the text that is already in a PDF, using Poppler.',
  submitLabel: 'Get text',
  input: { label: 'PDF file', accept: '.pdf,application/pdf' }, // use input: null for tools that take no file

  // Runs every time the page loads. Report missing programs and build the options.
  async setup() {
    return {
      missing: (await which('pdftotext')) ? [] : [missing('pdftotext', 'Poppler is not installed.')],
      notes: [],
      options: [
        { id: 'layout', type: 'checkbox', label: 'Keep the page layout', default: false },
      ],
    };
  },

  // ctx.input is { path, name, base }. ctx.options holds the checked values.
  async run(ctx) {
    const out = path.join(ctx.outDir, `${ctx.input.base}.txt`);
    const args = ctx.options.layout ? ['-layout'] : [];
    ctx.progress(null, null, 'Reading text');
    await ctx.run('pdftotext', [...args, ctx.input.path, out]);
    ctx.output(out, 'Text file');
  },
};
```

Option types:

- select: a dropdown. Give it choices, a list of { value, label }.
- checkbox: on or off.
- number: whole numbers, with min, max and optional.
- text, url and textarea: typed text, with maxLength and optional. url only accepts http and https addresses.

Every option can have help (shown under the label) and group (options with the same group share a fieldset).

Other tool settings:

- input: null for tools that take no file. Add optional: true if a file is allowed but not needed.
- validate(options, file): optional. Runs before the job starts. Throw userError('message') to show the message on the form. To move focus to a field, set the error's field to the option id, for example Object.assign(userError('...'), { field: 'model' }).

What a tool can use inside run(ctx):

- ctx.input: the uploaded file, with path, name (original name), base (a safe name without the extension) and ext (the extension, like .pdf). Null if no file was given.
- ctx.options: the checked option values.
- ctx.workDir: a folder for temporary files. It is deleted when the job ends, so do not put finished files here.
- ctx.outDir: put finished files here.
- ctx.run(command, args, settings): runs a program. It stops automatically if the job is cancelled. If the program fails, its error output goes in "Technical details". Settings can include onStdout and onStderr (to read progress as it happens), okCodes (exit codes that count as success, like [0, 1]), cwd and env.
- ctx.progress(value, max, text): updates the progress bar. Use null for value and max when you cannot tell how far along it is.
- ctx.output(filePath, label): adds a download link.
- ctx.finishMessage(text): a short result to read out when the job finishes. A job can finish with only a message and no files.
- ctx.review(publicData, privateState): ask the user to choose before finishing. publicData is { heading, intro, groups: [{ id, name, items: [{ id, label, detail, checked }] }], extraLabel, extraHelp, submitLabel }. It is shown as checkboxes grouped in fieldsets. When the user submits, tool.continue(ctx, privateState, { selected, extra }) runs as a new job in the same work folder. The Redactor uses this.
- ctx.link(href, text): adds a link under the result message.

Other new settings in 1.4:

- platforms: for example ['darwin'] to show a tool only on a Mac.
- remember: true on a text or textarea option keeps its value in the browser for next time.

## Shared document model

helpers/pdf_doc.py model IN.pdf OUT.json writes a document as JSON: each page's size, its lines of text with the position of every word, its form fields (name, label, type, value, position), and the document details. lib/to-pdf.js turns pictures and office files into PDFs and adds a text layer to scans. The Redactor is built on these, and they are meant as the base for a later accessible document editor and form filler.
- userError(message) from lib/system.js: throw this to show a plain message instead of "Something went wrong".

To add install hints for a new program, add it to the BREW list in lib/system.js.

## Changes

- 1.13: Renamed from CLI Wrappers to Quick Tool Box. Speech to text works on the home server (whisper.cpp is built into the container; models are kept in data/whisper-models). Your network details moved to .env: ALLOWED_NETWORKS applies to Quick Tool Box and Bus times, LLM_BIND controls who can reach the AI models, and ./setup.sh asks for your addresses instead of assuming them. Bus times added (Edmonton, optional). iPhone shares use the header X-Quick-Tool-Box (X-CLI-Wrappers still works). Licensed under the AGPL.
- 1.12: AI requests stream, show progress (reading, then words written) and wait their turn; the 5-minute timeout is gone; smaller pictures for the server; fast models (Qwen3 1.7B, Llama 3.2 3B, Gemma 3 1B); ./models.sh tune; thinking turned off on the server; Open WebUI extra requests off for new installs; mac/ollama-network.sh.
- 1.11: llama.cpp with llama-swap on the server instead of Ollama; ./setup.sh does the whole installation and tuning; ./models.sh downloads models; Open WebUI connected to the server and the Mac; ./docs.sh for Open WebUI documents; the Mac's Ethernet and Wi-Fi addresses both tried.
- 1.10: Find in a document has modes: Automatic, Lines, Boxes (T4-style slips) and Nearby, and a choice of how to read scans.
- 1.9: Find in a document. OCR can use a row-by-row page mode. iPhone shares open a tool's link when it makes no page.
- 1.8: Open WebUI and SearXNG added to docker-compose.yml, settings moved to .env, upload size limit that also works for chunked uploads, at most MAX_JOBS jobs at once, uploads written to disk without a second copy in memory, health check, log size limits, npm run check, and clean-ups.
- 1.7: Status page, Mac-first AI, Letters and bills reader, Describe an image, iPhone sharing, Docling server.
- 1.6: Text to speech (Kokoro).
- 1.5: Profiles, form filler, signatures.
- 1.4: Redactor, Menu reader, Docker.
