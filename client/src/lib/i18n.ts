// client/src/lib/i18n.ts
// Lightweight, dependency-free internationalisation. Strings are keyed by their
// English text, so wrapping existing UI is just `t('Dashboard')`. When the language
// is English we return the key unchanged; for Hindi we look it up, falling back to
// the English key if a translation is missing (so nothing ever renders blank).
//
// Language preference lives in the settings store, so `useT()` re-renders whenever
// the user switches language in Settings.
import { useSettings } from './settings';

type Dict = Record<string, string>;

// ── Hindi (हिन्दी) ─────────────────────────────────────────────────────────────
const hi: Dict = {
  // Sidebar — sections & nav
  'Overview': 'अवलोकन',
  'Monitoring': 'निगरानी',
  'Management': 'प्रबंधन',
  'System': 'सिस्टम',
  'Dashboard': 'डैशबोर्ड',
  'Machines': 'मशीनें',
  'Downtime': 'डाउनटाइम',
  'History Log': 'इतिहास लॉग',
  'Reports': 'रिपोर्ट',
  'Alerts': 'अलर्ट',
  'Employees': 'कर्मचारी',
  'Org Chart': 'संगठन चार्ट',
  'Departments': 'विभाग',
  'Roles & Permissions': 'भूमिकाएँ और अनुमतियाँ',
  'Settings': 'सेटिंग्स',
  'Sign out': 'साइन आउट',

  // Page header subtitles
  'Fleet data analysis & insights': 'फ्लीट डेटा विश्लेषण और अंतर्दृष्टि',
  'Idle, stopped & offline event log': 'निष्क्रिय, बंद और ऑफ़लाइन इवेंट लॉग',
  'Full telemetry archive': 'संपूर्ण टेलीमेट्री संग्रह',
  'Production, OEE & downtime summary': 'उत्पादन, OEE और डाउनटाइम सारांश',
  'Live anomaly detection across the fleet': 'पूरे फ्लीट में लाइव विसंगति पहचान',
  'Reporting structure': 'रिपोर्टिंग संरचना',
  'Company → Plant → Department → Role → User': 'कंपनी → प्लांट → विभाग → भूमिका → उपयोगकर्ता',
  'Dynamic RBAC — module access per role': 'डायनेमिक RBAC — प्रति भूमिका मॉड्यूल एक्सेस',
  'Preferences & configuration — saved on this device, never to the database': 'प्राथमिकताएँ और कॉन्फ़िगरेशन — इस डिवाइस पर सहेजा गया, डेटाबेस में कभी नहीं',

  // Settings — section nav labels
  'Profile & Account': 'प्रोफ़ाइल और खाता',
  'Company & Plants': 'कंपनी और प्लांट',
  'Alerts & Downtime': 'अलर्ट और डाउनटाइम',
  'Security & Access': 'सुरक्षा और एक्सेस',
  'Production & Quality': 'उत्पादन और गुणवत्ता',
  'Reports & Compliance': 'रिपोर्ट और अनुपालन',
  'System & Appearance': 'सिस्टम और रूप-रंग',

  // Settings — section titles & descriptions
  'My profile': 'मेरी प्रोफ़ाइल',
  'Personalise how you appear here. Your underlying account is managed centrally.': 'यहाँ आप कैसे दिखते हैं इसे निजीकृत करें। आपका मूल खाता केंद्रीय रूप से प्रबंधित होता है।',
  'Language & format': 'भाषा और प्रारूप',
  'How dates, numbers and the interface read for you.': 'दिनांक, संख्याएँ और इंटरफ़ेस आपके लिए कैसे दिखें।',
  'Notifications': 'सूचनाएँ',
  "Where you'd like to be notified. Channels other than in-app are delivered by the server.": 'आपको कहाँ सूचित किया जाए। इन-ऐप के अलावा अन्य चैनल सर्वर द्वारा भेजे जाते हैं।',
  'Company profile': 'कंपनी प्रोफ़ाइल',
  'Branding shown across the app. Updating the app name changes the sidebar instantly.': 'ऐप में दिखने वाली ब्रांडिंग। ऐप का नाम बदलने पर साइडबार तुरंत बदल जाता है।',
  'Plants': 'प्लांट',
  "Everest Kanto's manufacturing footprint. Counts are read live from the machine data.": 'एवरेस्ट कांटो की विनिर्माण उपस्थिति। गिनती मशीन डेटा से लाइव पढ़ी जाती है।',
  'Shift timings': 'शिफ्ट समय',
  'Used for shift-based reporting and quiet hours.': 'शिफ्ट-आधारित रिपोर्टिंग और शांत घंटों के लिए उपयोग होता है।',
  'Organisation': 'संगठन',
  'Departments and role access are managed on their own pages.': 'विभाग और भूमिका एक्सेस अपने-अपने पेजों पर प्रबंधित होते हैं।',
  'Alert thresholds': 'अलर्ट सीमाएँ',
  'Planning limits for pressure-vessel safety. The live alert engine runs server-side; these guide display & review.': 'प्रेशर-वेसल सुरक्षा के लिए योजना सीमाएँ। लाइव अलर्ट इंजन सर्वर पर चलता है; ये प्रदर्शन और समीक्षा में मदद करते हैं।',
  'Routing & escalation': 'रूटिंग और एस्केलेशन',
  'Who hears about what, and when.': 'कौन क्या और कब सुनता है।',
  'Downtime reasons': 'डाउनटाइम कारण',
  'The categories operators can pick when logging downtime.': 'डाउनटाइम दर्ज करते समय ऑपरेटर जिन श्रेणियों को चुन सकते हैं।',
  'Password policy': 'पासवर्ड नीति',
  'Recommended rules for new and changed passwords.': 'नए और बदले गए पासवर्ड के लिए अनुशंसित नियम।',
  'Session': 'सत्र',
  'Auto sign-out after inactivity.': 'निष्क्रियता के बाद स्वतः साइन-आउट।',
  'Two-factor authentication': 'दो-कारक प्रमाणीकरण',
  'Adds a second step at sign-in.': 'साइन-इन पर एक दूसरा चरण जोड़ता है।',
  'Change password': 'पासवर्ड बदलें',
  'Access & audit': 'एक्सेस और ऑडिट',
  'Login history and API access are recorded on the server.': 'लॉगिन इतिहास और API एक्सेस सर्वर पर दर्ज होते हैं।',
  'Product catalog': 'उत्पाद सूची',
  'Cylinder products manufactured across EKC plants.': 'EKC प्लांटों में निर्मित सिलेंडर उत्पाद।',
  'Process stages': 'प्रक्रिया चरण',
  'The cylinder manufacturing flow, in order.': 'सिलेंडर निर्माण प्रवाह, क्रम में।',
  'Standards & compliance': 'मानक और अनुपालन',
  'Regulatory standards the products are certified against.': 'नियामक मानक जिनके विरुद्ध उत्पाद प्रमाणित हैं।',
  'OEE targets': 'OEE लक्ष्य',
  'Plant-wide targets used as reference on dashboards & reports.': 'डैशबोर्ड और रिपोर्ट पर संदर्भ के रूप में उपयोग होने वाले प्लांट-व्यापी लक्ष्य।',
  'Batch / heat-number format': 'बैच / हीट-नंबर प्रारूप',
  'Export defaults': 'निर्यात डिफ़ॉल्ट',
  'Default format when exporting reports & history.': 'रिपोर्ट और इतिहास निर्यात करते समय डिफ़ॉल्ट प्रारूप।',
  'Scheduled reports': 'अनुसूचित रिपोर्ट',
  'Auto-email shift/daily summaries to managers.': 'प्रबंधकों को शिफ्ट/दैनिक सारांश स्वतः ईमेल करें।',
  'Compliance & maintenance': 'अनुपालन और रखरखाव',
  'Regulated-industry essentials for cylinder manufacturing.': 'सिलेंडर निर्माण के लिए विनियमित-उद्योग आवश्यकताएँ।',
  'Appearance': 'रूप-रंग',
  'Theme applies instantly across the whole app.': 'थीम पूरे ऐप में तुरंत लागू होती है।',
  'Units': 'इकाइयाँ',
  'Measurement units shown across the app.': 'ऐप में दिखाई जाने वाली माप इकाइयाँ।',
  'Reset': 'रीसेट',
  'Restore settings or clear all local display data on this device.': 'इस डिवाइस पर सेटिंग्स पुनर्स्थापित करें या सभी स्थानीय प्रदर्शन डेटा साफ़ करें।',
  'About': 'बारे में',

  // Settings — row labels
  'Language': 'भाषा',
  'Region / format': 'क्षेत्र / प्रारूप',
  'Time format': 'समय प्रारूप',
  'Timezone': 'समय क्षेत्र',
  'Interface language': 'इंटरफ़ेस भाषा',
  'In-app toasts': 'इन-ऐप सूचनाएँ',
  'Sound on alert': 'अलर्ट पर ध्वनि',
  'Email': 'ईमेल',
  'SMS': 'एसएमएस',
  'WhatsApp': 'व्हाट्सऐप',
  'Microsoft Teams': 'माइक्रोसॉफ्ट टीम्स',
  'App name': 'ऐप का नाम',
  'Tagline': 'टैगलाइन',
  'Legal name': 'कानूनी नाम',
  'Default plant': 'डिफ़ॉल्ट प्लांट',
  'Temperature — warning': 'तापमान — चेतावनी',
  'Temperature — critical': 'तापमान — गंभीर',
  'Pressure — warning': 'दबाव — चेतावनी',
  'Pressure — critical': 'दबाव — गंभीर',
  'Minimum severity to notify': 'सूचित करने की न्यूनतम गंभीरता',
  'Escalation chain': 'एस्केलेशन श्रृंखला',
  'Quiet hours': 'शांत घंटे',
  'Quiet window': 'शांत अवधि',
  'Minimum length': 'न्यूनतम लंबाई',
  'Require uppercase': 'बड़े अक्षर आवश्यक',
  'Require a number': 'एक संख्या आवश्यक',
  'Require a symbol': 'एक चिह्न आवश्यक',
  'Password expiry': 'पासवर्ड समाप्ति',
  'Session timeout': 'सत्र समय-समाप्ति',
  'Require 2FA': '2FA आवश्यक',
  'Availability target': 'उपलब्धता लक्ष्य',
  'Performance target': 'प्रदर्शन लक्ष्य',
  'Quality target': 'गुणवत्ता लक्ष्य',
  'Target OEE': 'लक्ष्य OEE',
  'Default export format': 'डिफ़ॉल्ट निर्यात प्रारूप',
  'Telemetry retention': 'टेलीमेट्री प्रतिधारण',
  'Enable scheduling': 'शेड्यूलिंग सक्षम करें',
  'Frequency': 'आवृत्ति',
  'Send at': 'इस समय भेजें',
  'Recipients': 'प्राप्तकर्ता',
  'Theme': 'थीम',
  'Density': 'घनत्व',
  'Temperature': 'तापमान',
  'Pressure': 'दबाव',

  // Profile / About info labels
  'Name': 'नाम',
  'Role': 'भूमिका',
  'Plant': 'प्लांट',
  'Last login': 'अंतिम लॉगिन',
  'Application': 'एप्लिकेशन',
  'Version': 'संस्करण',
  'Company': 'कंपनी',
  'Storage': 'भंडारण',

  // Segmented / button labels
  'Light': 'लाइट',
  'Dark': 'डार्क',
  'Comfortable': 'आरामदायक',
  'Compact': 'संक्षिप्त',
  '12-hour': '12-घंटे',
  '24-hour': '24-घंटे',
  'Info': 'जानकारी',
  'Warning': 'चेतावनी',
  'Critical': 'गंभीर',
  'Every shift': 'हर शिफ्ट',
  'Daily': 'दैनिक',
  'Weekly': 'साप्ताहिक',
  'Edit Profile': 'प्रोफ़ाइल संपादित करें',
  'Save changes': 'परिवर्तन सहेजें',
  'Cancel': 'रद्द करें',
  'Upload photo': 'फ़ोटो अपलोड करें',
  'Change photo': 'फ़ोटो बदलें',
  'Remove': 'हटाएँ',
  'Add': 'जोड़ें',
  'Reset settings to defaults': 'सेटिंग्स डिफ़ॉल्ट पर रीसेट करें',
  'Reset all local data': 'सभी स्थानीय डेटा रीसेट करें',
};

const DICTS: Record<string, Dict> = { hi };

export function translate(lang: string, key: string): string {
  if (!key || lang === 'en') return key;
  const d = DICTS[lang];
  return (d && d[key]) || key;
}

export type TFn = (key: string) => string;

// React hook returning a translate function bound to the current language.
export function useT(): TFn {
  const { locale } = useSettings();
  const lang = locale.language;
  return (key: string) => translate(lang, key);
}
