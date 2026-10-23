import mark from '@/assets/dovun-mark.svg';
import { productName, productWordmark } from '../../../../server/src/shared/brand.js';

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className="dovun-brand" aria-label={productName}>
      <img src={mark} className="dovun-brand-symbol" alt="" />
      {!compact && <strong>{productWordmark}</strong>}
    </div>
  );
}
