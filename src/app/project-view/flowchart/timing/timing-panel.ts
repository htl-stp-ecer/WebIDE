import { Component, EventEmitter, Input, Output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { Tooltip } from 'primeng/tooltip';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ChartModule } from 'primeng/chart';
import type { ChartData, ChartOptions } from 'chart.js';
import type { StepTiming } from '../flowchart-run-manager';

export type TimingViewMode = 'list' | 'chart';

@Component({
  selector: 'app-timing-panel',
  standalone: true,
  imports: [DecimalPipe, Tooltip, TranslateModule, ChartModule],
  templateUrl: './timing-panel.html',
  styleUrl: './timing-panel.scss',
})
export class TimingPanel {
  @Input() timings: StepTiming[] = [];
  @Input() maxDurationMs = 0;
  @Input() viewMode: TimingViewMode = 'list';
  @Output() viewModeChange = new EventEmitter<TimingViewMode>();

  constructor(private readonly translate: TranslateService) {}

  setViewMode(mode: TimingViewMode): void {
    this.viewModeChange.emit(mode);
  }

  get chartData(): ChartData<'line'> {
    const timings = this.timings;
    const labels = timings.map(t =>
      t.label || t.path || this.translate.instant('FLOWCHART.TIMING_STEP_INDEX', { value: t.index })
    );
    const data = timings.map(t => +(t.durationMs / 1000).toFixed(3));

    return {
      labels,
      datasets: [
        {
          label: this.translate.instant('FLOWCHART.TIMING_DURATION_LABEL'),
          data,
          borderColor: '#22c55e',
          backgroundColor: '#22c55e',
          pointBackgroundColor: '#22c55e',
          pointBorderColor: '#22c55e',
          pointRadius: 5,
          pointHoverRadius: 7,
          tension: 0.3,
          fill: false,
        },
      ],
    };
  }

  get chartOptions(): ChartOptions<'line'> {
    return {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => (items[0]?.label ? [items[0].label] : []),
            label: ctx => this.translate.instant('FLOWCHART.TIMING_TOOLTIP', { value: ctx.formattedValue }),
          },
        },
      },
      scales: {
        x: {
          title: { display: true, text: this.translate.instant('FLOWCHART.TIMING_STEP_LABEL') },
          ticks: { autoSkip: false, maxRotation: 35, minRotation: 0 },
        },
        y: {
          title: { display: true, text: this.translate.instant('FLOWCHART.TIMING_DURATION_LABEL') },
          beginAtZero: true,
        },
      },
    };
  }
}
