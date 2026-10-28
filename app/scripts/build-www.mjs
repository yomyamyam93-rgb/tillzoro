// 앱 안에 넣을 화면 파일을 저장소 맨 위에서 www/ 로 복사한다. 웹(GitHub Pages)과 앱이 같은 파일을 쓴다
import { cpSync, rmSync, mkdirSync } from "node:fs";
const files = ["index.html", "tokens.css", "privacy.html", "terms.html", "icon-512.png", "favicon.png", "apple-touch-icon.png"];
rmSync("www", { recursive: true, force: true });
mkdirSync("www");
for (const f of files) cpSync("../" + f, "www/" + f);
console.log("www:", files.length, "files");
