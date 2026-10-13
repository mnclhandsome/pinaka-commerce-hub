import { Injectable } from '@nestjs/common';
import { selectFeeLines, type OrderLine } from '../../../calculations/order-update.calculations';
import {
  calculateStoreOrder,
  type PosFeeLine,
  type PosTaxLine,
  type StoreOrderTotals,
  type TaxCalculationInput,
} from '../../../calculations/store-order.calculations';
import type { OrderGraph, TaxCommand } from '../order-update.types';

export interface PricingOptions {
  includeFees?: boolean;
  tax?: TaxCommand;
}

export interface PricedOrder {
  lineItems: OrderLine[];
  feeLines: PosFeeLine[];
  taxLines: PosTaxLine[];
  totals: StoreOrderTotals;
}

@Injectable()
export class OrderTotalsService {
  priceLines(graph: OrderGraph, lineItems: OrderLine[], options: PricingOptions = {}): PricedOrder {
    const places = 2;
    const feeLines = (Array.isArray(graph.storeOrder?.feeLines) ? graph.storeOrder.feeLines : []) as PosFeeLine[];
    const existingTax = (Array.isArray(graph.storeOrder?.taxLines) ? graph.storeOrder.taxLines : []) as PosTaxLine[];
    const payload = (graph.order.requestPayload || {}) as Record<string, unknown>;
    const shippingTotal = Number(payload.shipping_total ?? payload.shippingTotal ?? 0);
    const tax = this.taxInput(existingTax, options.tax);
    const feesForTotal = selectFeeLines(feeLines, options.includeFees, places);
    const calculated = calculateStoreOrder({
      lineItems,
      feeLines: feesForTotal,
      taxLines: tax ? [] : existingTax,
      tax,
      includeFees: feesForTotal.length > 0,
      shippingTotal: Number.isFinite(shippingTotal) ? shippingTotal : 0,
      decimalPlaces: places,
    });
    return {
      lineItems: calculated.lineItems as OrderLine[],
      feeLines,
      taxLines: tax ? calculated.taxLines : existingTax,
      totals: calculated.totals,
    };
  }

  private taxInput(
    existing: PosTaxLine[],
    override?: TaxCommand,
  ): Omit<TaxCalculationInput, 'lineItems' | 'feeLines'> | undefined {
    if (override && Number(override.rate) > 0) {
      return {
        rate: Number(override.rate),
        pricesIncludeTax: Boolean(override.pricesIncludeTax),
        calculation: override.calculation || 'item-price',
        label: override.label,
        decimalPlaces: 2,
      };
    }
    const rate = Number(existing[0]?.rate_percent || 0);
    if (rate <= 0) return undefined;
    return {
      rate,
      pricesIncludeTax: false,
      calculation: 'item-price',
      label: existing[0]?.label,
      decimalPlaces: 2,
    };
  }
}
