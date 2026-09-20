import { DEMO_NOTICE } from "../../domain/demo.js";

export function DemoNotice() {
  return <aside aria-label="Sample data notice" role="note" style={{
    padding: "0.7rem 1rem", background: "#fff4cc", color: "#382e0b",
    borderBottom: "1px solid #d6c576", fontSize: "0.85rem", lineHeight: 1.5,
  }}>{DEMO_NOTICE} Practice supports 10-question sessions; 40-question exams require the private bank.</aside>;
}
