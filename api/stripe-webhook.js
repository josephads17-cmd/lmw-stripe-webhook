// api/stripe-webhook.js
//
// Webhook Stripe pour La Maison Winnie.
//
// Écoute deux événements :
// - "checkout.session.completed" : premier paiement. Récupère le prénom
//   du lapin saisi dans le custom_field "prnomdulapin" du formulaire
//   Stripe Checkout, le copie dans les metadata de la subscription
//   (pour les renouvellements futurs), envoie l'email de rappel, et
//   ajoute une ligne dans le Google Sheet de suivi.
// - "invoice.payment_succeeded" : renouvellements mensuels automatiques
//   uniquement (le tout premier paiement est ignoré ici car déjà géré
//   par checkout.session.completed, pour éviter un double email/ligne).
//
// Variables d'environnement nécessaires (à configurer dans Vercel > Settings > Environment Variables) :
// - STRIPE_SECRET_KEY        : clé secrète Stripe (sk_live_..., sk_test_..., ou clé restreinte rk_live_.../rk_test_...)
// - STRIPE_WEBHOOK_SECRET    : secret de signature du webhook (whsec_...)
// - RESEND_API_KEY           : clé API Resend
// - NOTIFY_EMAIL             : ton adresse email pour recevoir les rappels (ex: onebrand.pro@gmail.com)
// - GOOGLE_SHEETS_CLIENT_EMAIL : "client_email" du fichier JSON du compte de service Google
// - GOOGLE_SHEETS_PRIVATE_KEY  : "private_key" du fichier JSON du compte de service Google
// - GOOGLE_SHEET_ID            : ID de la feuille Google Sheets (dans son URL, entre /d/ et /edit)

import Stripe from 'stripe';
import getRawBody from 'raw-body';
import { google } from 'googleapis';

export const config = {
  api: {
    bodyParser: false, // important : Stripe a besoin du body brut pour vérifier la signature
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Lit le body brut de la requête (nécessaire pour la vérification de signature Stripe).
// Utilise getRawBody (paquet officiel utilisé par Stripe/Vercel/Micro en interne)
// car la lecture manuelle via req.on('data'/'end') s'est révélée peu fiable
// sur certaines versions du runtime serverless de Vercel.
async function buffer(req) {
  return getRawBody(req, {
    length: req.headers['content-length'],
    limit: '1mb',
  });
}

// Ajoute une ligne dans le Google Sheet de suivi des commandes.
// N'interrompt jamais le webhook si ça échoue (on logge juste l'erreur) :
// on préfère un email envoyé sans ligne Sheet plutôt qu'un webhook qui
// plante entièrement à cause d'un souci Google.
async function appendToSheet({ date, customerName, customerEmail, rabbitName, preference, shippingAddress, phone, amount, type, stripeId }) {
  try {
    const auth = new google.auth.JWT(
      process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
      null,
      process.env.GOOGLE_SHEETS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/spreadsheets']
    );

    const sheets = google.sheets({ version: 'v4', auth });

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          date,
          customerName || 'Non renseigné',
          customerEmail || 'Non renseigné',
          rabbitName || 'Non renseigné',
          amount,
          type,
          'À préparer',
          '',
          stripeId,
          preference || 'Non renseignée',
          shippingAddress || 'Non renseignée',
          phone || 'Non renseigné',
        ]],
      },
    });
  } catch (err) {
    console.error('Erreur écriture Google Sheet:', err.message);
  }
}

const PREFERENCE_LABELS = {
  equilibree: 'Équilibrée',
  gourmande: 'Gourmande',
  occupation: 'Occupation',
  mastication: 'Mastication douce',
};

// Met en forme un objet adresse Stripe (line1, line2, postal_code, city,
// country) en une chaîne lisible pour l'email et le Sheet.
function formatAddress(address) {
  if (!address) return null;
  const parts = [
    address.line1,
    address.line2,
    [address.postal_code, address.city].filter(Boolean).join(' '),
    address.country,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

async function sendNotificationEmail({ customerName, customerEmail, rabbitName, preference, shippingAddress, phone, amount, isFirstPayment }) {
  const preferenceLabel = preference ? (PREFERENCE_LABELS[preference] || preference) : null;

  const subject = isFirstPayment
    ? `🐰 Nouvelle commande La Maison Winnie — Box pour ${rabbitName || 'un lapin'}`
    : `🐰 Renouvellement mensuel — Box pour ${rabbitName || 'un lapin'}`;

  const html = `
    <h2>${isFirstPayment ? 'Nouvelle commande !' : 'Renouvellement mensuel'}</h2>
    <p><strong>Lapin :</strong> ${rabbitName || 'Non renseigné'}</p>
    <p><strong>Préférence de composition :</strong> ${preferenceLabel || 'Non renseignée'}</p>
    <p><strong>Client :</strong> ${customerName || 'Non renseigné'}</p>
    <p><strong>Email client :</strong> ${customerEmail || 'Non renseigné'}</p>
    <p><strong>Téléphone :</strong> ${phone || 'Non renseigné'}</p>
    <p><strong>Adresse de livraison :</strong><br/>${shippingAddress || 'Non renseignée'}</p>
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

  // ---------------------------------------------------------------------
  // 1) checkout.session.completed — premier paiement uniquement.
  //    On récupère le prénom du lapin saisi dans le custom_field
  //    "prnomdulapin" du formulaire Stripe Checkout, puis on le copie
  //    dans les metadata de la subscription pour que cette info reste
  //    disponible lors des renouvellements mensuels suivants (l'event
  //    invoice.payment_succeeded n'a pas accès aux custom_fields).
  // ---------------------------------------------------------------------
  if (event.type === 'checkout.session.completed') {
    try {
      const session = event.data.object;

      const rabbitField = session.custom_fields?.find(
        (f) => f.key === 'prnomdulapin'
      );
      const rabbitName =
        rabbitField?.text?.value ||
        rabbitField?.dropdown?.value ||
        rabbitField?.numeric?.value ||
        null;

      const preferenceField = session.custom_fields?.find(
        (f) => f.key === 'preferencebox'
      );
      const preference =
        preferenceField?.dropdown?.value ||
        preferenceField?.text?.value ||
        null;

      if ((rabbitName || preference) && session.subscription) {
        const metadata = {};
        if (rabbitName) metadata.rabbit_name = rabbitName;
        if (preference) metadata.preference = preference;
        await stripe.subscriptions.update(session.subscription, { metadata });
      }

      // Sauvegarde l'adresse de livraison sur le customer Stripe (champ
      // natif "shipping"), pour qu'elle reste disponible et consultable
      // facilement à chaque renouvellement mensuel suivant.
      const shippingDetails = session.shipping_details;
      if (shippingDetails?.address && session.customer) {
        await stripe.customers.update(session.customer, {
          shipping: {
            name: shippingDetails.name || session.customer_details?.name || '',
            address: shippingDetails.address,
          },
        });
      }

      const customer = session.customer
        ? await stripe.customers.retrieve(session.customer)
        : null;

      const shippingAddress = formatAddress(
        session.shipping_details?.address || session.customer_details?.address
      );
      const phone = session.customer_details?.phone || customer?.phone || null;

      // Sauvegarde le téléphone sur le customer Stripe pour qu'il reste
      // disponible lors des renouvellements mensuels suivants.
      if (phone && session.customer && !customer?.phone) {
        await stripe.customers.update(session.customer, { phone });
      }

      await sendNotificationEmail({
        customerName: customer?.name || session.customer_details?.name,
        customerEmail: customer?.email || session.customer_details?.email,
        rabbitName,
        preference,
        shippingAddress,
        phone,
        amount: ((session.amount_total || 0) / 100).toFixed(2),
        isFirstPayment: true,
      });

      await appendToSheet({
        date: new Date().toLocaleDateString('fr-FR'),
        customerName: customer?.name || session.customer_details?.name,
        customerEmail: customer?.email || session.customer_details?.email,
        rabbitName,
        preference: PREFERENCE_LABELS[preference] || preference,
        shippingAddress,
        phone,
        amount: ((session.amount_total || 0) / 100).toFixed(2) + '€',
        type: 'Premier paiement',
        stripeId: session.id,
      });
    } catch (err) {
      console.error('Erreur traitement checkout.session.completed:', err);
    }
  }

  // ---------------------------------------------------------------------
  // 2) invoice.payment_succeeded — renouvellements mensuels automatiques.
  //    On ignore le tout premier paiement ici (billing_reason
  //    "subscription_create") car il est déjà notifié via
  //    checkout.session.completed ci-dessus — sinon on recevrait deux
  //    emails pour la même première commande.
  // ---------------------------------------------------------------------
  if (event.type === 'invoice.payment_succeeded') {
    try {
      const invoice = event.data.object;

      if (invoice.billing_reason === 'subscription_create') {
        // Déjà géré par checkout.session.completed, on ignore.
        return res.status(200).json({ received: true, skipped: 'handled_by_checkout_session' });
      }

      const customer = await stripe.customers.retrieve(invoice.customer);

      let rabbitName = null;
      let preference = null;
      if (invoice.subscription) {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
        rabbitName =
          subscription.metadata?.rabbit_name ||
          subscription.metadata?.prenom_lapin ||
          customer.metadata?.rabbit_name ||
          customer.metadata?.prenom_lapin ||
          null;
        preference = subscription.metadata?.preference || customer.metadata?.preference || null;
      }

      const shippingAddress = formatAddress(customer.shipping?.address);
      const phone = customer.phone || null;

      await sendNotificationEmail({
        customerName: customer.name,
        customerEmail: customer.email,
        rabbitName,
        preference,
        shippingAddress,
        phone,
        amount: (invoice.amount_paid / 100).toFixed(2),
        isFirstPayment: false,
      });

      await appendToSheet({
        date: new Date().toLocaleDateString('fr-FR'),
        customerName: customer.name,
        customerEmail: customer.email,
        rabbitName,
        preference: PREFERENCE_LABELS[preference] || preference,
        shippingAddress,
        phone,
        amount: (invoice.amount_paid / 100).toFixed(2) + '€',
        type: 'Renouvellement',
        stripeId: invoice.id,
      });
    } catch (err) {
      console.error('Erreur traitement invoice.payment_succeeded:', err);
      // On renvoie quand même 200 à Stripe pour éviter qu'il ne re-essaie indéfiniment
      // si l'erreur vient de notre côté (ex: Resend down) — à ajuster selon ta préférence.
    }
  }

  return res.status(200).json({ received: true });
}
