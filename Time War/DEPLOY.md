# 部署教學

## 1. 上傳到 GitHub
    cd time-war
    git init
    git add .
    git commit -m "鐘點戰"
    git branch -M main
    git remote add origin https://github.com/<你的帳號>/time-war.git
    git push -u origin main
（先在 github.com 建立一個空的 repo `time-war`，不要勾選加入 README。）

## 2. 部署（擇一）
### Render
1. render.com 登入 → New → Blueprint（或 Web Service）→ 選這個 repo。
2. Blueprint 會自動讀 `render.yaml`；手動建立則 Build: `npm install`、Start: `npm start`。
3. 完成後得到 `https://time-war-xxxx.onrender.com`。免費方案閒置會休眠，活動當天請改付費方案或活動前先開啟網址喚醒。
### Railway
New Project → Deploy from GitHub → 選 repo → Settings → Networking → Generate Domain。
### Docker / VPS / Fly.io
    docker build -t time-war .
    docker run -p 3000:3000 time-war

## 3. 當成 App 安裝（PWA）
開啟網址後：
- **Android Chrome**：選單 ⋮ →「安裝應用程式」/「加到主畫面」。
- **iPhone Safari**：分享按鈕 →「加入主畫面」。
安裝後以全螢幕開啟，有自己的圖示，遊戲中會保持螢幕常亮。PWA 需要 https（Render/Railway 都自動提供）。

## 注意
- 只能跑單一實例（遊戲狀態存在記憶體）；伺服器重啟會清空房間。
