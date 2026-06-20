// api/stripe-webhook.js
//
// Webhook Stripe pour La Maison Winnie.
// Écoute l'événement "invoice.payment_succeeded" (premier paiement ET
// renouvellements mensuels automatiques), puis envoie un email via Resend
// pour rappeler qu'une box doit être préparée et expédiée.
//
// Variables d'environnement nécessaires (à configurer dans Vercel > Settings > Environment Variables) :
// - STRIPE_SECRET_KEY      : clé secrète Stripe (sk_live_... ou sk_test_...)
// - STRIPE_WEBHOOK_SECRET  : secret de signature du webhook (whsec_...)
// - RESEND_API_KEY         : clé API Resend
// - NOTIFY_EMAIL           : ton adresse email pour recevoir les rappels (ex: onebrand.pro@gmail.com)

import Stripe from 'stripe';

export const config = {
  api: {
    bodyParser: false, // important : Stripe a besoin du body brut pour vérifier la signature
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Lit le body brut de la requête (nécessaire pour la vérification de signature Stripe)
function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

async function sendNotificationEmail({ customerName, customerEmail, rabbitName, amount, isFirstPayment }) {
  const subject = isFirstPayment
    ? `🐰 Nouvelle commande La Maison Winnie — Box pour ${rabbitName || 'un lapin'}`
    : `🐰 Renouvellement mensuel — Box pour ${rabbitName || 'un lapin'}`;

  const html = `
    <h2>${isFirstPayment ? 'Nouvelle commande !' : 'Renouvellement mensuel'}</h2>
    <p><strong>Lapin :</strong> ${rabbitName || 'Non renseigné'}</p>
    <p><strong>Client :</strong> ${customerName || 'Non renseigné'}</p>
    <p><strong>Email client :</strong> ${customerEmail || 'Non renseigné'}</p>
    <p><strong>Montant payé :</strong> ${amount}€</p>
    <hr />
    <p>👉 Action à faire : préparer et expédier la box, puis envoyer le numéro de suivi au client.</p>
  `;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'La Maison Winnie <notifications@lamaisonwinnie.com>',
      to: [process.env.NOTIFY_EMAIL],
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Erreur envoi email Resend:', errText);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method Not Allowed');
  }

  let event;

  try {
    const rawBody = await buffer(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Échec de vérification de signature webhook:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // On ne traite que les paiements de facture réussis (abonnement)
  if (event.type === 'invoice.payment_succeeded') {
    try {
      const invoice = event.data.object;

      // Récupère le customer Stripe pour avoir nom/email
      const customer = await stripe.customers.retrieve(invoice.customer);

      // Récupère la subscription pour lire les metadata (prénom du lapin)
      let rabbitName = null;
      if (invoice.subscription) {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        rabbitName =
          subscription.metadata?.rabbit_name ||
          subscription.metadata?.prenom_lapin ||
          customer.metadata?.rabbit_name ||
          customer.metadata?.prenom_lapin ||
          null;
      }

      // Détecte s'il s'agit du premier paiement ou d'un renouvellement
      const isFirstPayment = invoice.billing_reason === 'subscription_create';

      await sendNotificationEmail({
        customerName: customer.name,
        customerEmail: customer.email,
        rabbitName,
        amount: (invoice.amount_paid / 100).toFixed(2),
        isFirstPayment,
      });
    } catch (err) {
      console.error('Erreur traitement invoice.payment_succeeded:', err);
      // On renvoie quand même 200 à Stripe pour éviter qu'il ne re-essaie indéfiniment
      // si l'erreur vient de notre côté (ex: Resend down) — à ajuster selon ta préférence.
    }
  }

  return res.status(200).json({ received: true });
}
