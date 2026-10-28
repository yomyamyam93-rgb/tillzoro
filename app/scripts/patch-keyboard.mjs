/* 키보드 플러그인을 고쳐 쓴다.
 *
 * 원본은 웹뷰 프레임을 애니메이션 없이, 그것도 키보드가 다 올라온 뒤에(지속시간+0.2초)
 * 한 번에 바꾼다. 그래서 화면이 뚝 끊긴다.
 *
 * 애플은 알림에 키보드의 지속시간과 곡선을 같이 보낸다. 그걸 그대로 써서
 * 키보드와 같은 애니메이션 안에서 웹뷰를 움직이게 한다. 흉내가 아니라 같은 곡선이다.
 *
 * node_modules 는 저장소에 없으니 빌드할 때마다 여기서 고친다.
 * 플러그인을 올리면 아래 문자열이 안 맞아 빌드가 멈춘다. 그때 다시 맞추면 된다.
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "node_modules/@capacitor/keyboard/ios/Sources/KeyboardPlugin/Keyboard.m";
const MARK = "tzAnimateHeight";

let src = readFileSync(FILE, "utf8");

if (src.includes(MARK)) {
  console.log("키보드 플러그인: 이미 고쳐져 있음");
  process.exit(0);
}

const edits = [
  // 올라올 때: 키보드의 지속시간과 곡선으로 함께 움직인다
  [
    `  double duration = [[notification.userInfo valueForKey:UIKeyboardAnimationDurationUserInfoKey] doubleValue]+0.2;\n` +
      `  [self setKeyboardHeight:(int)height delay:duration];`,
    `  double duration = [[notification.userInfo valueForKey:UIKeyboardAnimationDurationUserInfoKey] doubleValue];\n` +
      `  NSInteger curve = [[notification.userInfo valueForKey:UIKeyboardAnimationCurveUserInfoKey] integerValue];\n` +
      `  [self tzAnimateHeight:(int)height duration:duration curve:curve];`,
  ],
  // 내려갈 때도 같은 곡선으로
  [
    `- (void)onKeyboardWillHide:(NSNotification *)notification\n{\n  [self setKeyboardHeight:0 delay:0.01];`,
    `- (void)onKeyboardWillHide:(NSNotification *)notification\n{\n` +
      `  [self tzAnimateHeight:0\n` +
      `               duration:[[notification.userInfo valueForKey:UIKeyboardAnimationDurationUserInfoKey] doubleValue]\n` +
      `                  curve:[[notification.userInfo valueForKey:UIKeyboardAnimationCurveUserInfoKey] integerValue]];`,
  ],
  // 실제로 움직이는 곳
  [
    `- (void)setKeyboardHeight:(int)height delay:(NSTimeInterval)delay\n{`,
    `- (void)tzAnimateHeight:(int)height duration:(NSTimeInterval)duration curve:(NSInteger)curve\n` +
      `{\n` +
      `  if (self.paddingBottom == height) { return; }\n` +
      `  self.paddingBottom = height;\n` +
      `  [NSObject cancelPreviousPerformRequestsWithTarget:self selector:@selector(_updateFrame) object:nil];\n` +
      `  if (duration <= 0) { [self _updateFrame]; return; }\n` +
      `  [UIView animateWithDuration:duration\n` +
      `                        delay:0\n` +
      `                      options:(UIViewAnimationOptions)((curve << 16) | UIViewAnimationOptionBeginFromCurrentState)\n` +
      `                   animations:^{ [self _updateFrame]; }\n` +
      `                   completion:nil];\n` +
      `}\n\n` +
      `- (void)setKeyboardHeight:(int)height delay:(NSTimeInterval)delay\n{`,
  ],
];

for (const [from, to] of edits) {
  const n = src.split(from).length - 1;
  if (n !== 1) {
    console.error(`키보드 플러그인을 고치지 못했다. 아래 조각이 ${n}번 나온다:\n---\n${from}\n---`);
    process.exit(1);
  }
  src = src.replace(from, to);
}

writeFileSync(FILE, src);
console.log("키보드 플러그인: 키보드와 같은 곡선으로 움직이도록 고침");
