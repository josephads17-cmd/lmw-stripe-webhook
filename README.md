# LMW — Webhook Stripe (rappel mensuel box)

Ce mini-projet écoute les paiements Stripe réussis de La Maison Winnie
(premier paiement + renouvellements mensuels automatiques) et envoie un
email de rappel pour préparer/expédier la box.

## Étapes de déploiement

### 1. Compte Resend (déjà fait)

- Domaine `lamaisonwinnie.com` vérifié sur Resend.
- Clé API Resend récupérée (commence par `re_...`).

### 2. Déployer sur Vercel

- Va sur https://vercel.com, "Add New Project".
- Sélectionne ce repo (`lmw-stripe-webhook`), pas le repo `winnie`.
- Vercel détecte automatiquement le dossier `api/` et déploie la fonction
  serverless.

### 3. Configurer les variables d'environnement dans Vercel

Vercel > ce projet > Settings > Environment Variables, ajoute :

| Nom | Valeur |
|---|---|
| `STRIPE_SECRET_KEY` | ta clé secrète Stripe (Dashboard Stripe > Developers > API keys) |
| `STRIPE_WEBHOOK_SECRET` | générée à l'étape 4 ci-dessous |
| `RESEND_API_KEY` | ta clé Resend |
| `NOTIFY_EMAIL` | l'adresse email où tu veux recevoir les rappels |

### 4. Créer le webhook dans Stripe

- Dashboard Stripe > Developers > Webhooks > "Add endpoint"
- URL à renseigner : `https://<ton-projet>.vercel.app/api/stripe-webhook`
  (l'URL exacte te sera donnée par Vercel après déploiement)
- Événement à écouter : `invoice.payment_succeeded`
- Une fois créé, Stripe te donne un "Signing secret" (commence par `whsec_...`)
  → c'est la valeur à mettre dans `STRIPE_WEBHOOK_SECRET`.

### 5. S'assurer que le prénom du lapin est bien dans les metadata

Pour que l'email affiche le prénom du lapin, il doit être stocké soit dans
les metadata du `customer` Stripe, soit dans celles de la `subscription`,
sous la clé `rabbit_name` ou `prenom_lapin`. Si ce n'est pas encore le cas
partout, il faut l'ajouter au moment de la création du customer/subscription
(souvent via le code qui gère le checkout, à vérifier selon comment le
checkout est actuellement configuré).

### 6. Tester

Stripe permet d'envoyer un événement de test depuis le Dashboard
(Webhooks > ton endpoint > "Send test webhook" > choisir
`invoice.payment_succeeded`). Vérifie que tu reçois bien l'email.

## Ce que fait le script

- Vérifie que la requête vient bien de Stripe (signature).
- Si c'est un paiement de facture réussi, récupère le nom/email du client
  et le prénom du lapin.
- Envoie un email via Resend avec toutes les infos utiles pour préparer
  la box.
- Différencie premier paiement ("Nouvelle commande") et renouvellement
  ("Renouvellement mensuel") dans l'objet de l'email.
