export interface CartItem {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export interface OrderResult {
  id: string;
  flow: 'v2';
}
