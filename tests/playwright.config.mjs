// 기본 동작 시험 설정. 정적 서버로 index.html 을 띄우고(8130), 폰 크기 크롬(설치된 크롬을 그대로 씀)으로 돌린다
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  timeout: 45000,
  retries: 1,            // 서버 응답이 느린 날의 한 번 실수는 봐준다. 두 번 연속 깨지면 진짜다
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "report" }]],
  use: { channel: "chrome", baseURL: process.env.BASE_URL || "http://localhost:8130/", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: process.env.BASE_URL ? undefined : { command: "python -m http.server 8130 --directory ..", port: 8130, reuseExistingServer: true },
});
