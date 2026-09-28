/** TC-A02-07 共享排程設定頁：需要 WP4（GPU 排程）API，M1 只放骨架。 */
export function SchedulingPlaceholder() {
  return (
    <>
      <h1>共享排程設定</h1>
      <section className="placeholder card" aria-labelledby="scheduling-title">
        <span className="badge badge--m2">WP4 預告</span>
        <h2 id="scheduling-title">此設定頁將於 GPU 排程 API（WP4）完成後提供</h2>
        <p>模組代碼：A-02（GPU 使用模式：獨占／共享排程）</p>
        <p className="text-muted">目前為頁面骨架，僅 Admin 可進入。</p>
      </section>
    </>
  );
}
