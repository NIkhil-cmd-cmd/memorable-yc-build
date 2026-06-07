'use client';

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import Link from 'next/link';

const HERO_WORD = 'Memorable';

const STEP_CARDS = [
  {
    id: 'ingest',
    title: 'INGEST',
    desc: 'Embed the incoming task from LiveKit session context.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="4" y="8" width="16" height="12" className="scene-line" />
        <path d="M12 4V14" className="scene-arrow" />
        <path d="M9 7L12 4L15 7" className="scene-arrow" />
      </svg>
    ),
  },
  {
    id: 'signal',
    title: 'SIGNAL',
    desc: 'K-means finds nearest workflow bucket + retrieval layers.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path
          d="M2 14C4 14 4 8 6 8C8 8 8 16 10 16C12 16 12 6 14 6C16 6 16 13 18 13C20 13 20 10 22 10"
          className="scene-wave"
        />
      </svg>
    ),
  },
  {
    id: 'relate',
    title: 'RELATE',
    desc: 'Concat bucket embedding with graph features into shared GNN.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <rect x="3" y="6" width="8" height="8" className="scene-line" />
        <rect x="13" y="10" width="8" height="8" className="scene-line" />
        <path d="M11 10L13 12" className="scene-arrow" />
      </svg>
    ),
  },
  {
    id: 'replay',
    title: 'REPLAY',
    desc: 'Score paths and replay safest workflow at runtime.',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden>
        <path d="M8 6L18 12L8 18Z" className="scene-line" />
      </svg>
    ),
  },
] as const;

const STEP_EXPLAIN: Record<string, { title: string; copy: string; points: string[] }> = {
  ingest: {
    title: 'Ingest: Task Embedding',
    copy: 'The current task/prompt is embedded from the live session before any routing decision.',
    points: [
      'LiveKit provides live session input + metadata.',
      'TrueFoundry carries model route metadata for inference.',
      'A dense task vector is produced for bucket routing.',
    ],
  },
  signal: {
    title: 'Signal: K-Means + 3-Layer Retrieval',
    copy: 'K-means maps the task embedding to the nearest workflow bucket, then Moss retrieves layered memory.',
    points: [
      'Nearest centroid -> bucket_id for similar prior workflows.',
      'L1 Episodic: raw traces from prior sessions.',
      'L2 Semantic: recurring tool-use patterns and outcomes.',
      'L3 Workflow: distilled playbooks exported from GNN.',
    ],
  },
  relate: {
    title: 'Relate: Bucket Embedding + Shared GNN',
    copy: 'The selected bucket embedding is concatenated with graph/tool features and passed through one shared GNN backbone.',
    points: [
      'Bucket embedding injects bucket-specific priors.',
      'Concat: [tool_graph_features | bucket_embedding].',
      'Single shared GNN scores candidate workflow paths.',
    ],
  },
  replay: {
    title: 'Replay: Path Selection Runtime',
    copy: 'The agent receives ranked path scores and replays the best route while suppressing known dead ends.',
    points: [
      'Cold and memory runs stay comparable in the same scenario.',
      'Avoid-list blocks known dead-end tools during memory mode.',
      'Replay logs show where memory path diverges from baseline.',
    ],
  },
};

const PIPELINE = ['Prompt', 'Tool Use', 'Execution', 'Trace', 'Workflow', 'Memory Graph'];
type IntegrationStatus = {
  integrations: {
    livekit: { configured: boolean };
    moss: { configured: boolean };
    truefoundry: { configured: boolean };
  };
  capabilities: {
    benchmark_api: boolean;
    sse_events: boolean;
    python_sdk: boolean;
    typescript_sdk: boolean;
    go_sdk: boolean;
    grpc_api: boolean;
  };
};

function RotatedSquares({ section }: { section: 'hero' | 'problem' | 'solution' | 'footer' }) {
  const specs =
    section === 'hero'
      ? [
          { cls: 'hatched tint-purple', s: 300, t: -90, l: -120, r: '12deg', x: '14px', y: '-8px' },
          { cls: 'hatched', s: 280, t: 320, l: 880, r: '-15deg', x: '-12px', y: '10px' },
        ]
      : section === 'problem'
        ? [{ cls: '', s: 360, t: 60, l: 920, r: '18deg', x: '10px', y: '12px' }]
        : section === 'solution'
          ? [
              { cls: 'hatched', s: 260, t: 90, l: -150, r: '7deg', x: '12px', y: '6px' },
              { cls: '', s: 210, t: 250, l: -110, r: '-13deg', x: '9px', y: '-8px' },
            ]
          : [
              { cls: 'hatched tint-rose', s: 260, t: -60, l: -80, r: '22deg', x: '8px', y: '9px' },
              { cls: 'hatched', s: 300, t: 120, l: 980, r: '-12deg', x: '-10px', y: '10px' },
              { cls: '', s: 220, t: 260, l: 860, r: '7deg', x: '12px', y: '-8px' },
            ];

  return (
    <div className="mem-squares" aria-hidden="true">
      {specs.map((sq, idx) => (
        <div
          key={`${section}-${idx}`}
          className={`mem-square ${sq.cls}`}
          style={
            {
              width: `${sq.s}px`,
              height: `${sq.s}px`,
              top: `${sq.t}px`,
              left: `${sq.l}px`,
              '--sq-rot': sq.r,
              '--sq-x': sq.x,
              '--sq-y': sq.y,
            } as CSSProperties & Record<'--sq-rot' | '--sq-x' | '--sq-y', string>
          }
        />
      ))}
    </div>
  );
}

function FlowchartScenes({ active }: { active: string }) {
  const detail = STEP_EXPLAIN[active] ?? STEP_EXPLAIN.replay;
  const ingestFocus = active === 'ingest' ? 'is-focus' : '';
  const signalFocus = active === 'signal' ? 'is-focus' : '';
  const relateFocus = active === 'relate' ? 'is-focus' : '';
  const replayFocus = active === 'replay' ? 'is-focus' : '';

  return (
    <div className={`flowchart-panel architecture-panel focus-${active}`} aria-live="polite">
      <div className="architecture-canvas">
        <svg viewBox="0 0 980 420" className="scene-svg arch-svg" aria-hidden>
          <g className="arch-world">
            <rect
              x="38"
              y="70"
              width="170"
              height="70"
              rx="10"
              className={`arch-box ${ingestFocus}`}
            />
            <text x="52" y="95" className="arch-title">
              LiveKit
            </text>
            <text x="52" y="114" className="arch-copy">
              voice rooms + stream
            </text>
            <text x="52" y="132" className="arch-copy">
              session metadata
            </text>

            <rect
              x="38"
              y="182"
              width="170"
              height="70"
              rx="10"
              className={`arch-box ${ingestFocus}`}
            />
            <text x="52" y="207" className="arch-title">
              Trace Events
            </text>
            <text x="52" y="226" className="arch-copy">
              tool_call / recall
            </text>
            <text x="52" y="244" className="arch-copy">
              benchmark logs
            </text>

            <rect
              x="326"
              y="36"
              width="230"
              height="60"
              rx="10"
              className={`arch-box ${ingestFocus}`}
            />
            <text x="342" y="61" className="arch-title">
              TrueFoundry Route Layer
            </text>
            <text x="342" y="80" className="arch-copy">
              openai / minimax / direct
            </text>

            <rect
              x="274"
              y="104"
              width="148"
              height="44"
              rx="8"
              className={`arch-box ${ingestFocus}`}
            />
            <text x="289" y="130" className="arch-copy">
              Task Embedding
            </text>

            <rect
              x="438"
              y="104"
              width="170"
              height="44"
              rx="8"
              className={`arch-box ${signalFocus}`}
            />
            <text x="453" y="130" className="arch-copy">
              K-Means Bucket Router
            </text>

            <rect
              x="274"
              y="162"
              width="334"
              height="184"
              rx="14"
              className={`arch-box ${signalFocus}`}
            />
            <text x="294" y="186" className="arch-title">
              Moss Memory Retrieval
            </text>
            <rect
              x="296"
              y="198"
              width="290"
              height="44"
              rx="8"
              className={`arch-subbox ${signalFocus}`}
            />
            <text x="314" y="225" className="arch-copy">
              L1 Episodic: prior session traces
            </text>
            <rect
              x="296"
              y="242"
              width="290"
              height="44"
              rx="8"
              className={`arch-subbox ${signalFocus}`}
            />
            <text x="314" y="269" className="arch-copy">
              L2 Semantic: repeated patterns
            </text>
            <rect
              x="296"
              y="286"
              width="290"
              height="34"
              rx="8"
              className={`arch-subbox ${signalFocus}`}
            />
            <text x="314" y="308" className="arch-copy">
              L3 Workflow: graph playbooks
            </text>

            <rect
              x="660"
              y="156"
              width="270"
              height="110"
              rx="12"
              className={`arch-box ${relateFocus}`}
            />
            <text x="678" y="184" className="arch-title">
              GNN Workflow Builder
            </text>
            <text x="678" y="206" className="arch-copy">
              edge ranking + route scoring
            </text>
            <text x="678" y="224" className="arch-copy">
              exports workflow index
            </text>
            <text x="678" y="242" className="arch-copy">
              concat [graph | bucket_emb]
            </text>

            <rect
              x="650"
              y="286"
              width="280"
              height="86"
              rx="12"
              className={`arch-box ${replayFocus}`}
            />
            <text x="668" y="313" className="arch-title">
              Agent Runtime Replay
            </text>
            <text x="668" y="334" className="arch-copy">
              memory injected before response
            </text>
            <text x="668" y="352" className="arch-copy">
              best path selected at turn time
            </text>

            <path d="M208 106L326 68" className={`arch-link ${ingestFocus}`} />
            <path d="M208 218L274 236" className={`arch-link ${ingestFocus}`} />
            <path d="M556 68L348 104" className={`arch-link ${ingestFocus}`} />
            <path d="M422 126L438 126" className={`arch-link ${signalFocus}`} />
            <path d="M523 148L523 162" className={`arch-link ${signalFocus}`} />
            <path d="M608 236L660 212" className={`arch-link ${signalFocus}`} />
            <path d="M608 126L660 198" className={`arch-link ${signalFocus}`} />
            <path d="M930 212L930 330H930" className={`arch-link ${relateFocus}`} />
            <path d="M608 304L650 328" className={`arch-link ${replayFocus}`} />
            <path
              id="arch-replay-path"
              d="M312 304C430 352 538 352 650 328"
              className={`arch-link-highlight ${replayFocus}`}
            />

            <circle r="5.5" className={`arch-travel-dot ${replayFocus}`}>
              <animateMotion dur="2.8s" repeatCount="indefinite">
                <mpath href="#arch-replay-path" />
              </animateMotion>
            </circle>
          </g>
        </svg>
      </div>
      <aside className="architecture-explain">
        <p className="mem-section-label">Focus: {detail.title}</p>
        <p className="architecture-copy">{detail.copy}</p>
        <ul className="architecture-points">
          {detail.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

export function LandingPage() {
  const [activeStep, setActiveStep] = useState('replay');
  const [navScrolled, setNavScrolled] = useState(false);
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [integrationStatus, setIntegrationStatus] = useState<IntegrationStatus | null>(null);

  const heroLetters = useMemo(
    () => HERO_WORD.split('').map((ch, i) => ({ ch, delay: `${i * 0.05}s` })),
    []
  );

  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 10);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>('.mem-reveal'));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
          }
        }
      },
      { threshold: 0.18 }
    );

    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const inkNodes = Array.from(document.querySelectorAll<HTMLElement>('.ink-trigger'));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('ink-visible');
          }
        }
      },
      { threshold: 0.62, rootMargin: '0px 0px -10% 0px' }
    );

    inkNodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const terminal = document.querySelector<HTMLElement>('#dev-terminal');
    if (!terminal) return;

    const lines = [
      '>>> from memorable import Memorable',
      '>>> memory = Memorable.from_env()',
      '>>> await memory.ensure_loaded()',
      '>>> await memory.query("billing dispute", mode="full")',
      "{'primary_layer': 'workflow', 'next_action': 'pull_account_billing'}",
    ];

    let started = false;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting || started) continue;
          started = true;
          setTerminalLines([]);
          lines.forEach((line, idx) => {
            window.setTimeout(() => {
              setTerminalLines((prev) => [...prev, line]);
            }, idx * 520);
          });
        }
      },
      { threshold: 0.34 }
    );

    observer.observe(terminal);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    fetch('/api/integrations/status', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setIntegrationStatus(data as IntegrationStatus);
      })
      .catch(() => null);
  }, []);

  return (
    <div className="memorable-landing">
      <div className="mem-grid-bg" aria-hidden="true" />
      <div className="mem-shell">
        <div className="landing-shell">
          <header className={`landing-nav ${navScrolled ? 'scrolled' : ''}`}>
            <div className="brand-wrap">
              <span className="brand-mark">{'{m}'}</span>
              <span className="brand-name">Memorable</span>
            </div>
            <nav className="nav-links">
              <a href="#product">Product</a>
              <a href="#integrations">Integrations</a>
              <a href="#docs">Docs</a>
              <a href="#enterprise">Enterprise</a>
            </nav>
            <Link href="/demo" className="mem-btn-outline" aria-label="Open demo">
              Open demo →
            </Link>
          </header>

          <section className="section-block" id="product">
            <RotatedSquares section="hero" />
            <div className="hero-grid mem-reveal">
              <div>
                <svg viewBox="0 0 460 340" className="hero-mark" aria-hidden="true">
                  <rect
                    x="18"
                    y="22"
                    width="420"
                    height="296"
                    rx="8"
                    className="logo-draw"
                    strokeDasharray="8 4"
                  />
                  <path d="M30 38L136 38" className="logo-draw" />
                  <path d="M332 38L436 38" className="logo-draw" />
                  <path d="M38 284L138 284" className="logo-draw" />
                  <path d="M322 284L420 284" className="logo-draw" />
                  <text x="228" y="220" textAnchor="middle" className="logo-letter">
                    M
                  </text>
                  <text x="34" y="70" style={{ fontFamily: 'var(--mem-mono)', fontSize: '12px' }}>
                    0x01
                  </text>
                  <text x="392" y="70" style={{ fontFamily: 'var(--mem-mono)', fontSize: '14px' }}>
                    {'//'}
                  </text>
                </svg>
              </div>

              <div>
                <h1 className="hero-title" aria-label="Memorable">
                  {heroLetters.map(({ ch, delay }, idx) => (
                    <span key={`${ch}-${idx}`} className="letter" style={{ animationDelay: delay }}>
                      {ch}
                    </span>
                  ))}
                </h1>
                <p className="hero-sub">
                  automated workflow generation
                  <br />+ memory layer
                </p>
                <Link href="/demo" className="mem-btn-dark hero-cta" aria-label="Open demo">
                  $ ./demo{' '}
                  <span className="term-cursor" style={{ marginLeft: 6 }}>
                    █
                  </span>
                </Link>
              </div>
            </div>
          </section>

          <section className="section-block section-sticky mem-reveal">
            <div className="section-stick">
              <RotatedSquares section="problem" />
              <p className="mem-section-label">↳ problem</p>
              <div className="problem-stage">
                <div className="problem-maze-center" aria-hidden="true">
                  <svg viewBox="0 0 1200 320" width="100%">
                    <path
                      id="problem-path-l"
                      className="problem-maze-path"
                      d="M20 160H220V118H430V160H600"
                    />
                    <path
                      id="problem-path-r"
                      className="problem-maze-path"
                      d="M1180 160H980V118H770V160H600"
                    />
                    <path
                      id="problem-path-t"
                      className="problem-maze-path"
                      d="M600 12V62H654V118H600V160"
                    />
                    <path
                      id="problem-path-b"
                      className="problem-maze-path"
                      d="M600 308V252H546V200H600V160"
                    />
                    <path
                      id="problem-path-lt"
                      className="problem-maze-path"
                      d="M60 42H220V102H432V152H600"
                    />
                    <path
                      id="problem-path-rt"
                      className="problem-maze-path"
                      d="M1140 42H980V102H768V152H600"
                    />
                    <path
                      id="problem-path-lb"
                      className="problem-maze-path"
                      d="M60 278H242V220H432V170H600"
                    />
                    <path
                      id="problem-path-rb"
                      className="problem-maze-path"
                      d="M1140 278H958V220H768V170H600"
                    />
                    <circle className="problem-maze-core" cx="600" cy="160" r="7" />
                    {[
                      ['problem-path-l', '10.5s', '0s'],
                      ['problem-path-r', '11.2s', '0.8s'],
                      ['problem-path-t', '12s', '0.4s'],
                      ['problem-path-b', '12.7s', '1.1s'],
                      ['problem-path-lt', '11.8s', '0.6s'],
                      ['problem-path-rt', '12.4s', '1.4s'],
                      ['problem-path-lb', '13.2s', '1s'],
                      ['problem-path-rb', '13.8s', '1.8s'],
                    ].map(([pathId, dur, begin]) => (
                      <circle key={pathId} className="problem-maze-dot" r="2.3">
                        <animateMotion dur={dur} begin={begin} repeatCount="indefinite">
                          <mpath href={`#${pathId}`} />
                        </animateMotion>
                      </circle>
                    ))}
                    <rect
                      x="408"
                      y="106"
                      width="384"
                      height="108"
                      rx="18"
                      className="problem-maze-veil"
                    />
                  </svg>
                </div>
                <h2 className="problem-title">
                  <span className="problem-line problem-line-1">
                    agents spend time trying to relearn workflows,
                  </span>
                  <br />
                  <span className="problem-line problem-line-2">
                    burning <span className="mem-accent-pink">tokens</span>,{' '}
                    <span className="mem-accent-purple">time</span>, and{' '}
                    <span className="mem-accent-green">money</span>
                  </span>
                </h2>
              </div>
            </div>
          </section>

          <section className="section-block section-sticky mem-reveal" id="enterprise">
            <div className="section-stick">
              <RotatedSquares section="solution" />
              <p className="mem-section-label">↳ solution</p>
              <p className="solution-copy section-title-reveal">
                <span className="ink-trigger ink-underline">Memorable</span> is a shared memory
                layer that{' '}
                <span className="solution-emphasis ink-trigger ink-circle">automatically</span>{' '}
                creates <span className="ink-trigger ink-underline">workflows</span>
                <br />
                for
              </p>
              <h2 className="enterprise-text section-title-reveal">ENTERPRISE AGENTS</h2>
              <div className="agent-share" aria-hidden="true">
                <div className="source-agent-wrap">
                  <div className="source-agent" />
                  <span className="source-agent-label">source agent</span>
                </div>
                <div className="memory-bus">
                  <span className="bus-line" />
                  <span className="bus-packet p1" />
                  <span className="bus-packet p2" />
                  <span className="bus-packet p3" />
                </div>
                <div className="agent-grid">
                  {new Array(6).fill(0).map((_, idx) => (
                    <div
                      key={idx}
                      className="agent-grid-item"
                      style={{ animationDelay: `${idx * 0.22}s` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>

          <section className="section-block section-sticky mem-reveal" id="integrations">
            <div className="section-stick">
              <p className="mem-section-label">↳ how it works</p>
              <div className="step-row">
                {STEP_CARDS.map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    className={`step-card ${activeStep === card.id ? 'active' : ''}`}
                    onMouseEnter={() => setActiveStep(card.id)}
                    onFocus={() => setActiveStep(card.id)}
                    aria-label={`Show ${card.title} flowchart`}
                  >
                    <div style={{ width: 28, height: 28 }}>{card.icon}</div>
                    <p className="step-name">{card.title}</p>
                    <p className="step-desc">{card.desc}</p>
                  </button>
                ))}
              </div>

              <p className="mem-quote">
                &gt; In this repo, memory mode runs the same scenario as cold mode and logs both
                traces for side-by-side comparison.
              </p>

              <FlowchartScenes active={activeStep} />
              <div className="integration-grid">
                <article className="integration-card">
                  <p className="integration-name">LiveKit</p>
                  <p className="integration-copy">
                    Voice room transport + token minting through <code>/api/token</code>.
                  </p>
                  <p className="integration-state">
                    {integrationStatus?.integrations.livekit.configured
                      ? 'configured'
                      : 'missing env vars'}
                  </p>
                </article>
                <article className="integration-card">
                  <p className="integration-name">Moss</p>
                  <p className="integration-copy">
                    Retrieval over knowledge / memory / workflow indexes via Python SDK.
                  </p>
                  <p className="integration-state">
                    {integrationStatus?.integrations.moss.configured
                      ? 'configured'
                      : 'missing env vars'}
                  </p>
                </article>
                <article className="integration-card">
                  <p className="integration-name">TrueFoundry</p>
                  <p className="integration-copy">
                    Optional OpenAI-compatible gateway route for model inference.
                  </p>
                  <p className="integration-state">
                    {integrationStatus?.integrations.truefoundry.configured
                      ? 'configured'
                      : 'optional, not configured'}
                  </p>
                </article>
              </div>
            </div>
          </section>

          <section className="section-block section-sticky mem-reveal">
            <div className="section-stick">
              <p className="mem-section-label">↳ memory formation</p>
              <h2
                className="solution-copy section-title-reveal"
                style={{ fontFamily: 'var(--mem-serif)' }}
              >
                Memorable seamlessly <strong>fits</strong> into{' '}
                <span className="solution-emphasis ink-trigger ink-circle">any</span> stack.
              </h2>
              <p style={{ marginTop: 12, color: 'var(--mem-muted)', fontSize: '0.9rem' }}>
                → init db, system gets exponentially better over time.
              </p>

              <div className="pipeline-row">
                {PIPELINE.map((label, idx) => (
                  <span
                    key={label}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                  >
                    <span
                      className="pipeline-pill mem-reveal"
                      style={{ transitionDelay: `${idx * 0.08}s` }}
                    >
                      {label}
                    </span>
                    {idx < PIPELINE.length - 1 && <span className="pipeline-arrow">→</span>}
                  </span>
                ))}
              </div>

              <div className="term-window" style={{ marginTop: 18 }}>
                <div className="term-top">
                  <span />
                  <span />
                  <span />
                </div>
                <pre className="term-body" style={{ margin: 0 }}>
                  {`from memorable import Memorable
memory = Memorable.from_env()
await memory.init_all()
result = await memory.query("billing dispute", mode="full")`}
                </pre>
              </div>
            </div>
          </section>

          <section className="section-block section-sticky mem-reveal" id="docs">
            <div className="section-stick">
              <div className="dev-grid">
                <div>
                  <h2 className="dev-title section-title-reveal">
                    Build with memory.
                    <br />
                    Ship <i style={{ fontStyle: 'italic' }}>intelligent</i> agents.
                  </h2>
                  <ul className="dev-list">
                    <li>REST APIs for benchmark runs, memory graph, and status</li>
                    <li>Python SDK in packages/memorable</li>
                    <li>LiveKit worker hook for cold/full memory mode</li>
                    <li>SSE event stream + exportable JSON trace logs</li>
                  </ul>
                </div>

                <div className="term-window" id="dev-terminal">
                  <div className="term-top">
                    <span />
                    <span />
                    <span />
                  </div>
                  <div className="term-body">
                    {terminalLines.map((line, idx) => (
                      <p key={`${idx}-${line}`} className="term-line">
                        {line}
                      </p>
                    ))}
                    <p className="term-line term-cursor">█</p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="footer-cta mem-reveal">
            <RotatedSquares section="footer" />
            <div className="footer-m">M</div>
            <p className="footer-copy">
              Memories that make agents <i>remarkable.</i>
            </p>
            <Link href="/demo" className="mem-btn-dark" aria-label="Open demo">
              Open demo →
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
