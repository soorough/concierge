import { useEffect, useRef, useState } from 'react';
import { api, money, type Brand, type Cart, type ThreadTurn } from './api';

type Props = {
  brand: Brand;
  sessionId: string;
  turns: ThreadTurn[];
  cart: Cart | null;
  showCheckout: boolean;
  needsAge: boolean;
  pending: boolean;
  onSend: (text: string) => void;
  onAge: (confirmed: boolean) => void;
  onCartChange: (cart: Cart) => void;
};

export function Phone({
  brand, sessionId, turns, cart, showCheckout, needsAge, pending, onSend, onAge, onCartChange,
}: Props) {
  const [draft, setDraft] = useState('');
  const [logoBroken, setLogoBroken] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  /*
   * Keeping a thread pinned to the newest message is not a one-shot scroll: bubbles,
   * the checkout card, and product images all change the content height after the
   * state update that added them. A ResizeObserver follows the real height instead.
   */
  useEffect(() => {
    const el = threadRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const pin = () => { el.scrollTop = el.scrollHeight; };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [turns.length, pending, showCheckout, cart?.lines.length]);

  useEffect(() => setLogoBroken(false), [brand.logo_url]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || pending) return;
    setDraft('');
    onSend(text);
  };

  const setQty = async (productId: string, qty: number) => {
    onCartChange(await api.setQty(brand.id, sessionId, productId, qty));
  };

  const initials = brand.name.replace(/[^A-Za-z ]/g, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('');

  return (
    <div className="phone">
      <div className="phone__bar">
        <div className={`phone__avatar${brand.logo_url && !logoBroken ? ' phone__avatar--logo' : ''}`}>
          {brand.logo_url && !logoBroken ? (
            // Shopify CDNs refuse hotlinked images when a referrer is sent, which
            // renders as a broken avatar rather than an error.
            <img
              src={brand.logo_url}
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setLogoBroken(true)}
            />
          ) : (
            initials
          )}
        </div>
        <div className="phone__name">{brand.name}</div>
      </div>

      <div className="thread" ref={threadRef}>
        <div className="thread__inner" ref={innerRef}>
        {turns.length === 0 && (
          <div className="bubble bubble--out">
            Ingested {brand.name}. Ask about anything they sell.
          </div>
        )}

        {turns.map((t) =>
          t.text ? (
            <div key={t.id} className={`bubble bubble--${t.direction}`}>
              {t.text}
            </div>
          ) : null,
        )}

        {pending && (
          <div className="typing" aria-label="Agent is typing">
            <i /><i /><i />
          </div>
        )}

        {needsAge && !pending && (
          <div className="chips">
            <button className="chip" onClick={() => onAge(true)}>I'm 21 or older</button>
            <button className="chip chip--ghost" onClick={() => onAge(false)}>I'm not</button>
          </div>
        )}

        {showCheckout && cart && cart.lines.length > 0 && (
          <div className="card">
            <div className="card__head">
              <span className="card__mark" />
              <span className="card__brand">{brand.name}</span>
              <span className="card__word">Checkout</span>
            </div>

            {cart.lines.map((l) => (
              <div className="line" key={l.product_id}>
                {l.image_url ? (
                  <img src={l.image_url} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <span className="line__thumb" />
                )}
                <div className="line__body">
                  <div className="line__title">{l.title}</div>
                  <div className="line__price">{money(l.price_cents, cart.currency)}</div>
                  <button className="line__remove" onClick={() => setQty(l.product_id, 0)}>
                    Remove
                  </button>
                </div>
                <div className="stepper">
                  <button aria-label="Decrease quantity" onClick={() => setQty(l.product_id, l.qty - 1)}>−</button>
                  <span>{l.qty}</span>
                  <button aria-label="Increase quantity" onClick={() => setQty(l.product_id, l.qty + 1)}>+</button>
                </div>
              </div>
            ))}

            <div className="card__total">
              <span>Subtotal · {cart.lines.reduce((n, l) => n + l.qty, 0)} item{cart.lines.reduce((n, l) => n + l.qty, 0) === 1 ? '' : 's'}</span>
              <b>{money(cart.subtotalCents, cart.currency)}</b>
            </div>

            {/* A storefront's product feed carries list prices; automatic promotions are
                applied at checkout. Saying so is better than showing a total the customer
                will not be charged. */}
            {brand.offers.length > 0 && (
              <div className="card__promo">{brand.offers[0]} — applied at checkout</div>
            )}

            {cart.permalink && (
              <a className="card__cta" href={cart.permalink} target="_blank" rel="noreferrer">
                Continue to checkout →
              </a>
            )}

            <div className="card__foot">
              <button onClick={async () => onCartChange(await api.clearCart(brand.id, sessionId))}>
                Clear cart
              </button>
            </div>
          </div>
        )}
        </div>
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Message"
          aria-label="Message"
          disabled={pending}
        />
        <button type="submit" disabled={pending || !draft.trim()} aria-label="Send">↑</button>
      </form>
    </div>
  );
}
