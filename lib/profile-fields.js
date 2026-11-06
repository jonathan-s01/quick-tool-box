// What a profile holds, and how form questions are matched to it.
// Matching only uses the wording of the question, never your answers, and runs on this server.

// whose: who the item is about. A question about your spouse only matches spouse items, and so on.
export const PROFILE_FIELDS = [
  { group: 'Name', items: [
    { id: 'firstName', label: 'First (given) name', match: [/\bfirst name\b/, /\bgiven names?\b/, /\bprénom/] },
    { id: 'middleName', label: 'Middle name', match: [/\bmiddle (name|initial)/, /\bsecond name\b/] },
    { id: 'lastName', label: 'Last name (surname)', match: [/\blast name\b/, /\bsurname\b/, /\bfamily name\b/, /\bnom de famille\b/] },
    { id: 'fullName', label: 'Full name', match: [/\bfull (legal )?name\b/, /^name$/, /\b(applicant|your|client|employee|claimant|patient|member)'?s? name\b/, /\bname of (applicant|client|claimant)\b/, /^nom$/] },
    { id: 'otherNames', label: 'Other or previous names', type: 'textarea', match: [/\b(other|previous|former|maiden|birth) (names?|surname)\b/] },
  ] },
  { group: 'Birth and identity', items: [
    { id: 'dob', label: 'Date of birth', type: 'date', match: [/\bdate of birth\b/, /\bbirth ?date\b/, /\bd\.?o\.?b\b/, /\bdate de naissance\b/] },
    { id: 'birthPlace', label: 'Place of birth', match: [/\bplace of birth\b/, /\bcountry of birth\b/, /\blieu de naissance\b/] },
    { id: 'sin', label: 'Social insurance number', match: [/\bsocial insurance\b/, /\bsin\b/, /\bnas\b/, /\bassurance sociale\b/] },
    { id: 'healthCard', label: 'Health care number', match: [/\bhealth (care|card)\b/, /\bahcip\b/, /\bphn\b/, /\bpersonal health number\b/, /\buli\b/] },
    { id: 'gender', label: 'Gender', match: [/\bgender\b/, /\bsex\b/, /\bsexe\b/] },
    { id: 'maritalStatus', label: 'Marital status', match: [/\bmarital status\b/, /\bétat civil\b/] },
    { id: 'citizenship', label: 'Citizenship', match: [/\bcitizenship\b/, /\bcitoyenneté\b/] },
    { id: 'language', label: 'Preferred language', match: [/\bpreferred language\b/, /\blanguage of correspondence\b/] },
  ] },
  { group: 'Contact', items: [
    { id: 'phone', label: 'Phone number', match: [/\b(tele)?phone\b/, /\bcell\b/, /\bmobile\b/, /\btéléphone\b/] },
    { id: 'email', label: 'Email address', match: [/\be-?mail\b/, /\bcourriel\b/] },
  ] },
  { group: 'Address', items: [
    { id: 'unit', label: 'Apartment or unit', match: [/\b(apt|apartment|unit|suite)\b/, /\baddress line 2\b/] },
    { id: 'street', label: 'Street address', match: [/\bstreet\b/, /\baddress( line 1)?\b/, /\bmailing address\b/, /\bhome address\b/, /\badresse\b/] },
    { id: 'city', label: 'City or town', match: [/\bcity\b/, /\btown\b/, /\bmunicipality\b/, /\bville\b/] },
    { id: 'province', label: 'Province', match: [/\bprovince\b/, /\bprov\b/, /\bstate\b/] },
    { id: 'postal', label: 'Postal code', match: [/\bpostal\b/, /\bzip\b/, /\bcode postal\b/] },
    { id: 'country', label: 'Country', match: [/\bcountry\b/, /\bpays\b/] },
    { id: 'pastAddresses', label: 'Past addresses, with dates', type: 'textarea', match: [/\b(previous|past|former) address/] },
  ] },
  { group: 'Spouse or partner', whose: 'spouse', items: [
    { id: 'spouseFirstName', label: 'Spouse first name', match: [/\bfirst name\b/, /\bgiven names?\b/] },
    { id: 'spouseLastName', label: 'Spouse last name', match: [/\blast name\b/, /\bsurname\b/] },
    { id: 'spouseFullName', label: 'Spouse full name', match: [/\bname\b/] },
    { id: 'spouseDob', label: 'Spouse date of birth', type: 'date', match: [/\bdate of birth\b/, /\bbirth ?date\b/] },
    { id: 'spouseSin', label: 'Spouse social insurance number', match: [/\bsocial insurance\b/, /\bsin\b/] },
  ] },
  { group: 'Dependants', items: [
    { id: 'dependants', label: 'Dependants (name, birth date, relationship), one per line', type: 'textarea', match: [/\bdependants?\b/, /\bdependents?\b/, /\bchildren\b/] },
  ] },
  { group: 'Work', whose: 'employer', items: [
    { id: 'employer', label: 'Employer name', match: [/\bemployer('?s)? name\b/, /^(current )?employer$/, /\bcompany( name)?$/, /\bname of (your )?employer\b/] },
    { id: 'occupation', label: 'Job title or occupation', whose: 'self', match: [/\boccupation\b/, /\bjob title\b/, /\bposition\b/] },
    { id: 'employerAddress', label: 'Employer address', match: [/\baddress\b/] },
    { id: 'employerPhone', label: 'Employer phone', match: [/\bphone\b/] },
  ] },
  { group: 'Banking, for direct deposit', items: [
    { id: 'bankName', label: 'Bank or credit union name', match: [/\b(bank|financial institution|credit union) name\b/, /\bname of (bank|financial institution)\b/] },
    { id: 'institution', label: 'Institution number (3 digits)', match: [/\binstitution (no|number|#)\b/, /\binstitution\b/] },
    { id: 'transit', label: 'Transit (branch) number (5 digits)', match: [/\btransit\b/, /\bbranch (no|number|#)\b/] },
    { id: 'account', label: 'Account number', match: [/\baccount (no|number|#)\b/, /\bnuméro de compte\b/] },
  ] },
  { group: 'Emergency contact', whose: 'emergency', items: [
    { id: 'emergencyName', label: 'Emergency contact name', match: [/\bname\b/] },
    { id: 'emergencyRelation', label: 'Relationship to you', match: [/\brelationship\b/] },
    { id: 'emergencyPhone', label: 'Emergency contact phone', match: [/\bphone\b/] },
  ] },
];

export const ALL_FIELDS = PROFILE_FIELDS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group, whose: i.whose || g.whose || 'self' })));
export const FIELD_BY_ID = Object.fromEntries(ALL_FIELDS.map((f) => [f.id, f]));

function whoseOf(text) {
  if (/\b(spouse|partner|husband|wife|conjoint)\b/.test(text)) return 'spouse';
  if (/\bemergency\b/.test(text)) return 'emergency';
  if (/\b(employer|company)\b/.test(text)) return 'employer';
  if (/\b(child|dependant|dependent|witness|guarantor|co-?applicant|parent|guardian|landlord|doctor|physician|representative|agent|preparer|signing officer)\b/.test(text)) return 'other';
  return 'self';
}

/** Value of a profile item, including custom items (custom:<n>). */
export function profileValue(profile, key) {
  if (!key) return '';
  if (key.startsWith('custom:')) return profile.custom?.[Number(key.slice(7))]?.value || '';
  if (key === 'fullName' && !profile.fields?.fullName) {
    return [profile.fields?.firstName, profile.fields?.middleName, profile.fields?.lastName].filter(Boolean).join(' ');
  }
  if (key === 'spouseFullName' && !profile.fields?.spouseFullName) {
    return [profile.fields?.spouseFirstName, profile.fields?.spouseLastName].filter(Boolean).join(' ');
  }
  return profile.fields?.[key] || '';
}

/** The profile item for one question, or null. */
export function matchQuestion(field, profile) {
  const label = field.label.toLowerCase();
  const all = `${label} ${String(field.context || '').toLowerCase()} ${String(field.section || '').toLowerCase()}`;
  if (field.kind === 'signature' || field.kind === 'checkbox') return null;
  // Year, month and day boxes for a date.
  const part = /^(year|yyyy|aaaa|année)$/.test(label) ? 'year' : /^(month|mm|mois)$/.test(label) ? 'month' : /^(day|dd|jj|jour)$/.test(label) ? 'day' : null;
  let whose = whoseOf(label);
  if (whose === 'self') whose = whoseOf(`${field.context || ''}`.toLowerCase());
  if (whose === 'self' && /\b(spouse|partner)\b/.test(String(field.section || '').toLowerCase())) whose = 'spouse';
  if (whose === 'other') return null;
  if (part) {
    if (/\bbirth\b/.test(all)) return { key: whose === 'spouse' ? 'spouseDob' : 'dob', part };
    return null;
  }
  // Custom items: the question has to contain the custom item's name.
  (profile.custom || []).forEach((c, i) => {
    if (c.label && label.includes(c.label.toLowerCase())) field._custom = `custom:${i}`;
  });
  if (field._custom) return { key: field._custom };
  for (const f of ALL_FIELDS) {
    if (f.whose !== whose) continue;
    if (f.match.some((re) => re.test(label))) return { key: f.id };
  }
  return null;
}

/** Date format the form asks for, from its wording. */
export function dateFormat(text) {
  const t = String(text || '').toUpperCase().replace(/AAAA/g, 'YYYY').replace(/JJ/g, 'DD');
  let m = /YYYY([-/. ]?)MM\1DD/.exec(t);
  if (m) return `YYYY${m[1]}MM${m[1]}DD`;
  m = /DD([-/. ]?)MM\1YYYY/.exec(t);
  if (m) return `DD${m[1]}MM${m[1]}YYYY`;
  m = /MM([-/. ]?)DD\1YYYY/.exec(t);
  if (m) return `MM${m[1]}DD${m[1]}YYYY`;
  return 'YYYY-MM-DD';
}

/** Turns a stored date (YYYY-MM-DD) into the form's format, or one part of it. */
export function formatDate(iso, fmt, part) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return String(iso || '');
  const [, y, mo, d] = m;
  if (part === 'year') return y;
  if (part === 'month') return mo;
  if (part === 'day') return d;
  return fmt.replace('YYYY', y).replace('MM', mo).replace('DD', d);
}

/** Value to put in a question, shaped to fit the field. */
export function shapeValue(field, match, profile) {
  const def = FIELD_BY_ID[match.key];
  let v = profileValue(profile, match.key);
  if (!v) return '';
  if (def?.type === 'date') v = formatDate(v, dateFormat(`${field.label} ${field.context || ''}`), match.part);
  if (field.maxlen && v.length > field.maxlen && /^(sin|spouseSin|phone|postal|institution|transit|account|healthCard)$/.test(match.key)) {
    v = v.replace(/[\s()-]/g, '');
  }
  if (field.kind === 'select' && field.options?.length) {
    const hit = field.options.find((o) => o.toLowerCase() === v.toLowerCase()) || field.options.find((o) => o.toLowerCase().startsWith(v.toLowerCase().slice(0, 4)));
    return hit || '';
  }
  if (field.kind === 'radio') {
    const hit = field.options.find((o) => o.label.toLowerCase() === v.toLowerCase()) || field.options.find((o) => o.label.toLowerCase().startsWith(v.toLowerCase().slice(0, 4)));
    return hit ? hit.value : '';
  }
  return v;
}

/**
 * Some forms split one answer over several boxes (a SIN in three boxes of 3).
 * When neighbouring fields on one row match the same item and are too short for it, share the value out.
 */
export function splitAcrossBoxes(fields, values) {
  const groups = new Map();
  for (const f of fields) {
    if (!f.match || f.match.part || !f.maxlen) continue;
    const k = `${f.match.key}|${f.page}|${Math.round(f.rect[1] / 4)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => a.rect[0] - b.rect[0]);
    let rest = String(values[g[0].id] || '').replace(/[\s-]/g, '');
    for (const f of g) {
      values[f.id] = rest.slice(0, f.maxlen);
      rest = rest.slice(f.maxlen);
    }
  }
}
