/* ============================================================
   analytics.js — Google Analytics 4 loader.

   This is the ONLY file in the repo that holds the measurement
   ID. Every page loads this script ID-free:

     <script async src="js/analytics.js"></script>

   so changing the property is a one-line edit here, no matter
   how many pages the site grows to.

   The ID is public by design — GA4 exposes it in page source on
   every site that uses it — so baking it into committed source
   is correct, and means CI needs no extra configuration.
   ============================================================ */

const GA_ID = 'G-5YP5JLC01S';

const s = document.createElement('script');
s.async = true;
s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
document.head.appendChild(s);

window.dataLayer = window.dataLayer || [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', GA_ID);
