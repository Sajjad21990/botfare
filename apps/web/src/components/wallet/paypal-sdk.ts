/**
 * PayPal JavaScript SDK v6 (sandbox): loads `web-sdk/v6/core` once and types the small part of its
 * surface the wallet uses (createInstance, findEligibleMethods, one-time payment sessions).
 * Never load the v5 `sdk/js` script on the same page.
 */

export const PAYPAL_SDK_URL = "https://www.sandbox.paypal.com/web-sdk/v6/core";

export interface PayPalApproveData {
  orderId: string;
  payerId?: string;
}

export interface PayPalSdkError extends Error {
  code?: string;
}

export interface PayPalPaymentSessionCallbacks {
  onApprove: (data: PayPalApproveData) => Promise<void>;
  onCancel?: (data?: { orderId?: string }) => void;
  onError?: (error: PayPalSdkError) => void;
}

export interface PayPalOneTimePaymentSession {
  /** The second argument must be a Promise (an invoked createOrder), never a function. */
  start(
    options: { presentationMode: "auto" | "popup" | "modal" | "redirect" },
    order: Promise<{ orderId: string }>,
  ): Promise<void>;
  hasReturned?: () => boolean;
  resume?: () => Promise<void>;
  destroy?: () => void;
}

export interface PayPalEligibleMethods {
  isEligible(method: "paypal" | "venmo" | "paylater" | "credit"): boolean;
}

export interface PayPalSdkInstance {
  findEligibleMethods(options: {
    currencyCode: string;
    amount?: string;
  }): Promise<PayPalEligibleMethods>;
  createPayPalOneTimePaymentSession(
    callbacks: PayPalPaymentSessionCallbacks,
  ): PayPalOneTimePaymentSession;
}

interface PayPalNamespace {
  createInstance(options: {
    clientId: string;
    components: string[];
    pageType?: string;
    locale?: string;
  }): Promise<PayPalSdkInstance>;
}

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      /** PayPal's v6 button web component. */
      "paypal-button": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        type?: "pay" | "checkout" | "buynow" | "subscribe";
        disabled?: boolean;
      };
    }
  }
}

let loading: Promise<PayPalNamespace> | null = null;

function paypalGlobal(): PayPalNamespace | undefined {
  return (window as unknown as { paypal?: PayPalNamespace }).paypal;
}

/** Loads the v6 core script (async) once per page; resolves with `window.paypal`. */
export function loadPayPalSdk(): Promise<PayPalNamespace> {
  const existing = paypalGlobal();
  if (existing?.createInstance) return Promise.resolve(existing);
  loading ??= new Promise<PayPalNamespace>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PAYPAL_SDK_URL;
    script.async = true;
    script.onload = () => {
      const paypal = paypalGlobal();
      if (paypal?.createInstance) resolve(paypal);
      else reject(new Error("The PayPal SDK loaded without createInstance"));
    };
    script.onerror = () => reject(new Error("Could not load the PayPal SDK"));
    document.head.appendChild(script);
  }).catch((err) => {
    loading = null; // allow a retry
    throw err;
  });
  return loading;
}
