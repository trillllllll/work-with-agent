import { ColumnChart, type ColumnChartProps } from './BarChart.js';

export function StackedBarChart(props: Omit<ColumnChartProps, 'mode'>) {
  return <ColumnChart {...props} mode="stack" />;
}
