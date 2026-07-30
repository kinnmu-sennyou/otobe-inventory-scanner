QR棚卸カメラスキャナー 同一画面入力版

GitHubへ上書きするファイル
- index.html
- style.css
- app.js
- config.js
- .nojekyll

Apps Scriptへ追加・更新するファイル
- Code.gs：全貼り換え
- Bridge.html：新規追加

変更内容
- QR読取後に別ページへ移動しません。
- カメラ画面の上へ商品情報と数量入力を重ねて表示します。
- +10、+1、数字入力、Enter加算、1つ戻す、全消去に対応します。
- 総計・登録後、入力画面が自動で閉じて同じカメラで次の商品を読めます。
- カメラを再起動しないため、登録後のNotAllowedErrorを避けられます。

公開手順
1. Apps ScriptのCode.gsを全貼り換え
2. Apps ScriptへBridge.htmlを新規追加
3. Apps Scriptを新バージョンとして再デプロイ
4. GitHubへ5ファイルを上書き
5. GitHub Pagesを携帯で再読み込み
6. カメラを起動して実機確認
