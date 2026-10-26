# Download no-licenses videos

## Sources
* https://dareful.com/ (great, free CC BY 4.0, no people)
* https://pixabay.com/videos/

Paid:
* https://elements.envato.com/ (15e/mo unlimited)

## Download all dareful.com videos
```sh
node download.mjs            # all pages (resumable; already-downloaded videos are skipped)
node download.mjs --from 1 --to 1   # only page 1
```
Videos are saved one by one to `videos/`, and `video-tags-map.csv` records `file name`, `tags`, `url` (video page URL). Files larger than 50 MB are skipped to stay under GitHub's file size limit.

## Download incompetech.com audio
```sh
node download-audio.mjs --dry-run   # list matching tracks only
node download-audio.mjs             # download (resumable; existing files are skipped)
```
Downloads every track from https://incompetech.com/music/royalty-free/music.html whose Feel includes any of: Relaxed, Grooving, Calming, Driving, Suspenseful, Mysterious, Somber (tracks longer than 10 min or larger than 50 MB are skipped). MP3s go to `audio/`, and `audio-metadata.txt` holds one block per downloaded track (title, feel, genre, album, length, BPM, instruments, description, ISRC, links, CC BY 4.0 attribution).

## Clean up commited files
Add those to `.gitignore`, then:
```
git rm -r --cached .
git add .
```