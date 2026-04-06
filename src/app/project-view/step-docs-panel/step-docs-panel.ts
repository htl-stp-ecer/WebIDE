import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpService } from '../../services/http-service';
import { StepsStateService } from '../../services/steps-state-service';
import { ActivatedRoute } from '@angular/router';
import { Subscription } from 'rxjs';
import { Skeleton } from 'primeng/skeleton';

interface ParsedParam {
  name: string;
  type: string | null;
  dflt: string | null;
}

interface ParsedSignature {
  name: string;
  params: ParsedParam[];
}

interface DocStep {
  name: string;
  tags: string[];
  signature: string;
  docstring: string;
  module: string;
  brief: string;
}

const TAG_HUE: Record<string, string> = {
  calibration: 'tag-rust',
  drive: 'tag-sky',
  motion: 'tag-sky',
  control: 'tag-amber',
  concurrent: 'tag-amber',
  sensor: 'tag-green',
  light: 'tag-green',
  servo: 'tag-berry',
  timing: 'tag-dim',
  wait: 'tag-dim',
  ui: 'tag-dim',
  distance: 'tag-dim',
  motor: 'tag-sky',
  deadzone: 'tag-dim',
  'line-follow': 'tag-sky',
};

function tagClass(t: string): string {
  return TAG_HUE[t] || 'tag-dim';
}

function firstSentence(text: string): string {
  const m = text.match(/^[^.!?\n]+[.!?]/);
  return (m ? m[0] : text.split('\n')[0]).trim();
}

function parseSig(sig: string): ParsedSignature {
  const m = sig.match(/^(\w+)\s*\(([\s\S]*)\)\s*(?:->.*)?$/);
  if (!m) return { name: sig, params: [] };
  const name = m[1];
  const argsStr = m[2].trim();
  if (!argsStr) return { name, params: [] };

  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of argsStr) {
    if ('[({'.includes(ch)) depth++;
    else if ('])}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());

  const params = parts.map(p => {
    let d = 0, ci = -1;
    for (let i = 0; i < p.length; i++) {
      if ('[({'.includes(p[i])) d++;
      else if ('])}'.includes(p[i])) d--;
      else if (p[i] === ':' && d === 0) { ci = i; break; }
    }
    if (ci === -1) {
      const ei = p.indexOf('=');
      return ei === -1
        ? { name: p, type: null, dflt: null }
        : { name: p.slice(0, ei).trim(), type: null, dflt: p.slice(ei + 1).trim() };
    }
    const pname = p.slice(0, ci).trim();
    const rest = p.slice(ci + 1).trim();
    let ed = 0, ei = -1;
    for (let i = 0; i < rest.length; i++) {
      if ('[({'.includes(rest[i])) ed++;
      else if ('])}'.includes(rest[i])) ed--;
      else if (rest[i] === '=' && ed === 0) { ei = i; break; }
    }
    return ei === -1
      ? { name: pname, type: rest, dflt: null }
      : { name: pname, type: rest.slice(0, ei).trim(), dflt: rest.slice(ei + 1).trim() };
  });

  return { name, params };
}

function norm(str: string): string {
  return str.toLowerCase().replace(/[_\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordMatch(text: string, tok: string): boolean {
  return new RegExp('(?:^|[^a-z])' + escRe(tok) + '(?:[^a-z]|$)').test(text);
}

function scoreStep(step: DocStep, tokens: string[]): number {
  if (!tokens.length) return 1;
  const normName = norm(step.name);
  const normTags = step.tags.map(norm).join(' ');
  const normBrief = norm(step.brief);
  const normDoc = norm(step.docstring);

  const allMatch = tokens.every(tok =>
    normName.includes(tok) || normTags.includes(tok) ||
    normBrief.includes(tok) || normDoc.includes(tok)
  );
  if (!allMatch) return 0;

  let s = 0;
  const nameAllMatch = tokens.every(tok => normName.includes(tok));
  if (nameAllMatch) {
    if (normName === tokens.join(' ')) s += 100;
    else if (normName.startsWith(tokens[0])) s += 60;
    else tokens.forEach(tok => { if (wordMatch(normName, tok)) s += 30; else s += 10; });
  }
  tokens.forEach(tok => { if (normTags.includes(tok)) s += 20; });
  tokens.forEach(tok => { if (wordMatch(normBrief, tok)) s += 8; });
  tokens.forEach(tok => { if (wordMatch(normDoc, tok)) s += 2; });
  return s;
}

interface ParsedArg {
  name: string;
  type: string | null;
  dflt: string | null;
  desc: string;
}

interface DocSection {
  type: 'text' | 'args' | 'returns';
  content?: string;
  args?: ParsedArg[];
}

function parseDocstring(docstring: string, paramMap: Record<string, ParsedParam>): DocSection[] {
  if (!docstring) return [];
  const sections: DocSection[] = [];
  const lines = docstring.split('\n');

  let currentSection: 'text' | 'args' | 'returns' | 'example' = 'text';
  let textBuffer: string[] = [];
  let argsBuffer: ParsedArg[] = [];
  let currentArg: ParsedArg | null = null;
  let returnsBuffer: string[] = [];
  let skipExample = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^Args:\s*$/.test(trimmed)) {
      if (textBuffer.length) {
        sections.push({ type: 'text', content: textBuffer.join('\n').trim() });
        textBuffer = [];
      }
      currentSection = 'args';
      continue;
    }

    if (/^Returns:\s*$/.test(trimmed)) {
      if (currentArg) { argsBuffer.push(currentArg); currentArg = null; }
      if (argsBuffer.length) {
        sections.push({ type: 'args', args: argsBuffer });
        argsBuffer = [];
      }
      if (textBuffer.length) {
        sections.push({ type: 'text', content: textBuffer.join('\n').trim() });
        textBuffer = [];
      }
      currentSection = 'returns';
      continue;
    }

    if (/^Examples?::?\s*$/.test(trimmed)) {
      if (currentArg) { argsBuffer.push(currentArg); currentArg = null; }
      if (argsBuffer.length) {
        sections.push({ type: 'args', args: argsBuffer });
        argsBuffer = [];
      }
      if (returnsBuffer.length) {
        sections.push({ type: 'returns', content: returnsBuffer.join('\n').trim() });
        returnsBuffer = [];
      }
      if (textBuffer.length) {
        sections.push({ type: 'text', content: textBuffer.join('\n').trim() });
        textBuffer = [];
      }
      skipExample = true;
      currentSection = 'example';
      continue;
    }

    if (skipExample) continue;

    if (currentSection === 'args') {
      const argMatch = line.match(/^[ \t]{4}(\w+):\s*(.*)/);
      if (argMatch) {
        if (currentArg) argsBuffer.push(currentArg);
        const info = paramMap[argMatch[1]] || { type: null, dflt: null };
        currentArg = { name: argMatch[1], type: info.type, dflt: info.dflt, desc: argMatch[2] };
      } else if (currentArg && trimmed) {
        currentArg.desc += ' ' + trimmed;
      }
      continue;
    }

    if (currentSection === 'returns') {
      if (trimmed) returnsBuffer.push(trimmed);
      continue;
    }

    textBuffer.push(line);
  }

  // Flush remaining
  if (currentArg) argsBuffer.push(currentArg);
  if (argsBuffer.length) sections.push({ type: 'args', args: argsBuffer });
  if (returnsBuffer.length) sections.push({ type: 'returns', content: returnsBuffer.join('\n').trim() });
  if (textBuffer.length) {
    const text = textBuffer.join('\n').trim();
    if (text) sections.push({ type: 'text', content: text });
  }

  return sections;
}

@Component({
  selector: 'app-step-docs-panel',
  standalone: true,
  imports: [NgClass, FormsModule, Skeleton],
  templateUrl: './step-docs-panel.html',
  styleUrls: ['./step-docs-panel.scss'],
})
export class StepDocsPanel implements OnInit, OnDestroy {
  allSteps = signal<DocStep[]>([]);
  loading = signal(true);
  searchQuery = signal('');
  activeTag = signal<string | null>(null);
  expandedSteps = signal<Set<string>>(new Set());

  allTags = computed(() => {
    const counts: Record<string, number> = {};
    for (const step of this.allSteps()) {
      for (const tag of step.tags) {
        counts[tag] = (counts[tag] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tag, count]) => ({ tag, count, cls: tagClass(tag) }));
  });

  visibleSteps = computed(() => {
    const steps = this.allSteps();
    const raw = this.searchQuery().trim();
    const tokens = norm(raw).split(' ').filter(t => t.length > 0);
    const tag = this.activeTag();

    return steps
      .map(s => ({ s, score: scoreStep(s, tokens) }))
      .filter(x => x.score > 0 && (!tag || x.s.tags.includes(tag)))
      .sort((a, b) => b.score - a.score)
      .map(x => x.s);
  });

  groupedSteps = computed(() => {
    const visible = this.visibleSteps();
    const raw = this.searchQuery().trim();
    const tag = this.activeTag();

    if (raw || tag) {
      return [{ key: '', steps: visible }];
    }

    const groups: Record<string, DocStep[]> = {};
    for (const step of visible) {
      const key = step.tags[0] || 'other';
      (groups[key] = groups[key] || []).push(step);
    }
    return Object.keys(groups).sort().map(key => ({ key, steps: groups[key] }));
  });

  countLabel = computed(() => {
    const total = this.allSteps().length;
    const visible = this.visibleSteps().length;
    const raw = this.searchQuery().trim();
    const tag = this.activeTag();
    if (raw || tag) return `Showing ${visible} of ${total} steps`;
    return `${total} steps available`;
  });

  private refreshSub?: Subscription;
  private projectUUID: string | null = null;

  constructor(
    private http: HttpService,
    private stepsState: StepsStateService,
    private route: ActivatedRoute,
  ) {}

  ngOnInit(): void {
    this.projectUUID = this.route.snapshot.paramMap.get('uuid');
    this.loadDocs();
    this.refreshSub = this.stepsState.refresh$.subscribe(() => this.loadDocs());
  }

  ngOnDestroy(): void {
    this.refreshSub?.unsubscribe();
  }

  private loadDocs(): void {
    if (!this.projectUUID) {
      this.allSteps.set([]);
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.http.getAllSteps(this.projectUUID).subscribe({
      next: (steps) => {
        const docSteps: DocStep[] = steps
          .filter(s => s.docstring && s.signature)
          .map(s => ({
            name: s.name,
            tags: s.tags ?? [],
            signature: s.signature!,
            docstring: s.docstring!,
            module: s.import,
            brief: firstSentence(s.docstring!),
          }));
        docSteps.sort((a, b) => {
          const tagCmp = (a.tags[0] || 'zzz').localeCompare(b.tags[0] || 'zzz');
          return tagCmp !== 0 ? tagCmp : a.name.localeCompare(b.name);
        });
        this.allSteps.set(docSteps);
        this.loading.set(false);
      },
      error: () => {
        this.allSteps.set([]);
        this.loading.set(false);
      },
    });
  }

  toggleTag(tag: string): void {
    this.activeTag.set(this.activeTag() === tag ? null : tag);
  }

  toggleStep(stepName: string): void {
    const set = new Set(this.expandedSteps());
    if (set.has(stepName)) set.delete(stepName);
    else set.add(stepName);
    this.expandedSteps.set(set);
  }

  isExpanded(stepName: string): boolean {
    return this.expandedSteps().has(stepName);
  }

  clearSearch(): void {
    this.searchQuery.set('');
  }

  tagClass(tag: string): string {
    return tagClass(tag);
  }

  compactSigHtml(sig: string): string {
    const { name, params } = parseSig(sig);
    const ps = params.map(p => `<span class="sig-p">${esc(p.name)}</span>`).join('<span class="sig-sep">, </span>');
    return `<span class="sig-name">${esc(name)}</span><span class="sig-punc">(</span>${ps}<span class="sig-punc">)</span>`;
  }

  fullSigHtml(sig: string): string {
    const { name, params } = parseSig(sig);
    if (!params.length) return `<span class="sig-name">${esc(name)}</span><span class="sig-punc">()</span>`;
    const renderParam = (p: ParsedParam) => {
      let h = `<span class="sig-p">${esc(p.name)}</span>`;
      if (p.type) h += `<span class="sig-colon">: </span><span class="sig-type">${esc(p.type)}</span>`;
      if (p.dflt) h += `<span class="sig-eq"> = </span><span class="sig-dflt">${esc(p.dflt)}</span>`;
      return h;
    };
    if (params.length === 1) {
      return `<span class="sig-name">${esc(name)}</span><span class="sig-punc">(</span>${renderParam(params[0])}<span class="sig-punc">)</span>`;
    }
    const lines = params.map((p, i) =>
      `  ${renderParam(p)}${i < params.length - 1 ? '<span class="sig-punc">,</span>' : ''}`
    ).join('\n');
    return `<span class="sig-name">${esc(name)}</span><span class="sig-punc">(</span>\n${lines}\n<span class="sig-punc">)</span>`;
  }

  getDocSections(step: DocStep): DocSection[] {
    const { params } = parseSig(step.signature);
    const paramMap: Record<string, ParsedParam> = {};
    params.forEach(p => paramMap[p.name] = p);
    return parseDocstring(step.docstring, paramMap);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
