/**
 * tools/ 全系的输出层。install / uninstall 原来各写一份一模一样的
 * say/step/info/ok/warn/die，release / build-shell-cs 是小变体，这里收敛成一处。
 *
 * 风格约定（全项目统一）：
 *   say()     原始一行
 *   step()    主流程的分步标题：【n/total】标题
 *   phase()   副标题：▶ xxx（不分步的场景用）
 *   info()    缩进详情
 *   ok()      ✓ 成功
 *   warn()    ! 警告（不中断）
 *   die()     ✗ 致命错误，打印后 process.exit
 */
export function say(msg = "") {
  process.stdout.write(msg + "\n");
}

export function step(n, total, title) {
  say(`\n【${n}/${total}】${title}`);
}

export function phase(msg) {
  say(`\n▶ ${msg}`);
}

export function info(msg) {
  say(`  ${msg}`);
}

export function ok(msg) {
  say(`  ✓ ${msg}`);
}

export function warn(msg) {
  say(`  ! ${msg}`);
}

export function die(msg, code = 1) {
  process.stdout.write(`\n✗ ${msg}\n`);
  process.exit(code);
}
