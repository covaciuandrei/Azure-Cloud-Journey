import { Icon } from "../components/Icon.js";

export function ExamSelection({ onSelect }: { onSelect: () => void }) {
  return <section className="exam-selection" aria-labelledby="exam-selection-title">
    <header className="exam-selection-heading">
      <span className="workspace-eyebrow">AZURE CLOUD JOURNEY</span>
      <h1 id="exam-selection-title">Your next step in Azure starts here.</h1>
      <p>Choose your exam and make room for understanding. Learn the reasoning, put it into practice, and build on what you know.</p>
    </header>
    <div className="exam-selection-layout">
      <article className="exam-card" aria-labelledby="az104-title">
        <div className="exam-card-top">
          <span className="exam-card-symbol"><Icon name="book" size={28} /></span>
          <span className="exam-available"><span />Available to study</span>
        </div>
        <span className="exam-code">AZ-104</span>
        <h2 id="az104-title">Azure Administrator</h2>
        <p>A dedicated workspace for your Azure administration study, from networking concepts to exam-style practice.</p>
        <ul className="exam-capabilities">
          <li><Icon name="book" size={18} /><span><strong>Learn with context</strong>Guided networking lessons and worked examples</span></li>
          <li><Icon name="grid" size={18} /><span><strong>Put your knowledge to work</strong>Topic-based questions and timed mock exams</span></li>
          <li><Icon name="history" size={18} /><span><strong>Keep moving forward</strong>Saved sessions, results and learning progress</span></li>
        </ul>
        <div className="exam-card-action">
          <button className="button button-primary" onClick={onSelect}>Select AZ-104<Icon name="arrow" size={18} /></button>
          <span>Opens your Learn and Practice workspace</span>
        </div>
      </article>
      <aside className="exam-study-path" aria-labelledby="exam-study-path-title">
        <span className="workspace-eyebrow">ONE CLEAR STEP AT A TIME</span>
        <h2 id="exam-study-path-title">Understanding first.<br />Confidence through practice.</h2>
        <ol>
          <li><span className="exam-step-number" aria-hidden="true">01</span><div><h3>Make the concepts click</h3><p>Start with a guided lesson. Work through examples and check your understanding as you go.</p></div></li>
          <li><span className="exam-step-number" aria-hidden="true">02</span><div><h3>Find your focus</h3><p>Practise by topic or try a timed mock exam. Review the reasoning behind each answer.</p></div></li>
          <li><span className="exam-step-number" aria-hidden="true">03</span><div><h3>Pick up where you left off</h3><p>Return to your lessons and saved sessions. Your progress stays with your workspace.</p></div></li>
        </ol>
      </aside>
    </div>
    <div className="exam-selection-notes">
      <p><Icon name="book" size={18} /><span><strong>A focused learning pilot.</strong> Guided lessons currently cover networking, not every AZ-104 domain.</span></p>
      <p><Icon name="download" size={18} /><span><strong>Your pace, your place.</strong> Start as a guest and use Offline &amp; data to download your study materials.</span></p>
    </div>
  </section>;
}
