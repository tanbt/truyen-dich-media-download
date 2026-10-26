# Prompts
## Download videos one by one
```md
Open the website https://dareful.com/ in this vscode built-in browser, navigate to each of its page.
For each page, download video files there to `videos` folder, one by one. Then move on to the next page and continue downloading until the last video in the last page.

Each video has a list of tags, create the video-tags-map.csv file to keep track of it. The file has 3 columns: 
* file name: the file name that is downloaded
* tags: tags of the video, divided by commas
* url: the original url of the video
```


## Script to slow videos to 2x and remove audio
Ensure `ffmpeg` is installed e.g. via brew, check by `which ffmpeg`:
```sh
for f in videos/*.mp4; do ffmpeg -i "$f" -vf "setpts=2.0*PTS" -an "videos_2x/$(basename "$f")"; done
```

## Download audio
```md
Open this website https://incompetech.com/music/royalty-free/music.html in the vscode built-in browser, navigate and donwload all audio/mp3 files filtered by these Feels: Relaxed, Grooving, Calming, Driving, Suspenseful, Mysterious, Somber. Save them to `audio` folder. Also create a file audio-metadata.txt to store name and all metadatas of each audio.
```