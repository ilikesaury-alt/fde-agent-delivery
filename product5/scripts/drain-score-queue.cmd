@echo off
REM Drain the product-5 score queue by firing batches of /api/score.
REM Kept as a .cmd because bash treats "batch $i:" as a command (hit this once).
REM Two gotchas (both hit in practice):
REM   1) Never pass the token via "set /p" - the TEMP file carries CRLF,
REM      which corrupts the Authorization header (401).
REM   2) Node fetch does not honor the system proxy (known issue) - must use curl -x.
REM Fix: node only writes a header file (plain LF), curl reads it via -H @file.
setlocal
cd /d "H:\Work\Projects\Personal\fde-agent-delivery\product5"

node -e "const fs=require('fs');const s=require('./.secrets.json');fs.writeFileSync('scripts/.p5hdr.txt','authorization: Bearer '+s.ACCESS_TOKEN+'\n','utf8');"

for %%i in (1 2 3 4 5 6 7 8) do (
  echo === batch %%i ===
  curl -s -x http://127.0.0.1:7890 -m 300 -X POST -H @scripts/.p5hdr.txt "https://ai-hot-radar.ilikesaury.workers.dev/api/score?limit=30" -o "%TEMP%\p5score.json"
  node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.env.TEMP+'\\p5score.json','utf8'));console.log('scored='+j.scored,'dropped='+j.dropped,'failed='+j.failed,'dead='+j.dead,'pending='+j.pending);"
)
del /q scripts\.p5hdr.txt
endlocal
