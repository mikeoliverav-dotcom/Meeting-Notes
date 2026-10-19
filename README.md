# Meeting Notes

Record a video call, grab screenshots and type quick notes as it happens. Afterwards, transcribe the recording **right in your browser** with Whisper and turn everything into clean notes with Claude, with your screenshots placed where they belong. Recordings, transcripts and notes are stored only on your computer.

Works in **Chrome or Microsoft Edge on a Windows PC or Mac**. It doesn't work on phones or iPads, because they don't let web pages record other apps.

---

## 1. Put it online (once, about 10 minutes)

The same steps as Site Walk:

1. Create a new GitHub repository, for example `meeting-notes`. A public repository works with a free GitHub account. Only the app's code goes in it, never your recordings.
2. Upload the **contents** of this folder: `index.html`, `app.js`, `whisper-worker.js`, `README.md` and the `vendor` folder. Use Chrome or Edge so the `vendor` folder comes along.
3. Go to **Settings → Pages → Deploy from a branch → `main` / `(root)` → Save**.
4. After a minute or two the app is live at `https://<your-username>.github.io/meeting-notes/`. Bookmark it.

Recording and transcription need a secure **https** address, which GitHub Pages provides. Opening `index.html` straight from your desktop won't work.

---

## 2. Setting up Whisper (the transcription)

**There's nothing to install.** Whisper is OpenAI's open-source speech-recognition model. The app runs it inside your browser using a library called transformers.js. Your audio never leaves your computer, and there's no account, API key or fee.

**The first time you click Transcribe:**
1. The app downloads the speech model from Hugging Face, a public library of AI models. You'll see "Downloading the speech model (one time)" with a progress bar.
   - **English, fast:** about 80–100 MB. Start with this one.
   - **English, more accurate:** about 250–400 MB, and roughly 3× slower.
   - **Other languages:** about 80–100 MB.
2. The browser saves the model, so from then on transcription starts right away, even after you close the browser. Each quality setting downloads once.
3. Do the first download on a decent connection, such as office Wi-Fi.

**Speed.** The app uses your graphics card (WebGPU) when the browser allows it, and falls back to the processor otherwise. The panel shows which one it used.
- With the graphics card on a typical modern laptop, an hour of audio takes several minutes.
- On the processor only, it can take as long as the meeting itself, or longer on an older laptop.
- You can keep working in other tabs while it runs, but leave this tab open. If you close it, click **Continue transcribing** later and it resumes where it stopped.

**If the download is blocked.** Some company networks block Hugging Face or cdn.jsdelivr.net. If the progress bar never moves, try once from another network, such as home or a phone hotspot. After that the model is saved and the block doesn't matter. If IT needs to allow it, the two addresses are `huggingface.co` (with `cdn-lfs.huggingface.co`) and `cdn.jsdelivr.net`.

**If your computer is too slow.** Use **English — fast** and plug the laptop in. If it's still too slow, the alternative is a paid cloud speech service at roughly a cent per minute. Ask Claude to add that option.

---

## 3. Using it

1. **New meeting**, then give it a name.
2. **Start recording** and choose what to share:
   - **Meeting in a browser tab** (Google Meet, Zoom or Teams on the web): pick the **Chrome/Edge tab** and keep **"Share tab audio"** on.
   - **Teams or Zoom desktop app:** pick **Entire screen** and turn on **"Share system audio"**.
   - Sharing a single *window* doesn't include its sound. If the Call audio meter stays flat, stop and share a tab or the entire screen instead.
   - "Include my mic" adds your voice. **Headphones** keep the call audio from being picked up twice.
3. During the call:
   - **📷 Screenshot** freezes what you're sharing; drag a box around the part you want and it's captured when you let go (or press **Enter** to reuse the last area, or **Whole screen**). You can also press **Win+Shift+S**, snip, then **Ctrl+V** in the app. Add a short caption, such as "Option B slide", because it helps Claude place the screenshot.
   - Type notes and press **Enter**. Use **★ Important** (or the ★ on any note) for the things that matter most. Starred items always appear in a highlighted **Flagged as important** section at the top of the final notes.
   - **Pause** and **Stop** are in step 1. **Record more** adds to the same meeting.
4. **Transcribe recording** (step 2). You can also choose **Use an audio file…** to transcribe a recording from elsewhere, such as a Teams or Zoom recording or a voice memo.
5. **Copy for Claude** (step 3), paste it into a Claude chat, and copy Claude's reply.
6. Copy Claude's reply with the **Copy** button under it (or select it and press Ctrl+C; headings, bullets and tables are kept either way), paste it in step 4 and click **Save final notes**. Screenshot tags like `[IMG-4F2A]` turn back into the actual screenshots. Any screenshot Claude didn't place goes into an "Other screenshots" section at the end. Claude organizes the discussion into a **Timeline** of time-stamped segments, and the app drops each note you typed, word for word, into the segment it was taken in, shown in a blue "My note" box.
7. **Download** (step 5): **PDF** (choose "Save as PDF" in the print window), **Word**, the **Transcript** as a text file, or the **Audio**.

**Recording etiquette and the law:** tell everyone on the call that you're recording. Texas only requires one party's consent, but participants in other states may be covered by all-party consent laws.

---

## Good to know

- **Back-to-back meetings:** click **← Meetings** at the top to stop the recording and go straight to your list, then start the next meeting. Each meeting shows what's left: **To transcribe**, **To write up** or **Done**. Open any of them later to finish.

- **Storage:** everything lives in this browser on this computer. An hour of audio is about 15 MB, and screenshots are a few hundred KB each. Delete old meetings from step 5 to free space. Clearing your browser's site data for this address deletes the meetings too.
- **No speaker names:** Whisper writes down what was said, not who said it. Claude names speakers only when it's clear from the conversation or your notes.
- **Updating:** replace the files on GitHub. The browser picks up the new version the next time you open the app, and existing meetings are kept.

## Files

| File | Purpose |
|---|---|
| `index.html` | Screens and styling |
| `app.js` | Recording, notes, screenshots, timeline, Claude handoff, exports |
| `whisper-worker.js` | Runs the Whisper speech model in the background |
| `vendor/docx.umd.js` | Builds the Word file |
