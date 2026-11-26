/**
 * Terms of Service and Privacy Policy, as data. Every value that appears in more than
 * one place lives in LEGAL.
 *
 * Factual basis: agent/src/capabilities.ts (integrations), agent/src/registry and
 * agent/src/agent.ts (what is stored), agent/src/clerk.ts (authentication),
 * agent/src/whatsapp.ts (WhatsApp), agent/src/payments.ts (crypto payments),
 * agent/src/razorpay.ts and agent/src/routes/card.ts (card and UPI payments in India).
 */

export const LEGAL = {
  /** The individual who operates the Service. */
  operator: "Dhairya Shah",
  product: "Salts",
  country: "India",
  /** Governing law. */
  jurisdiction: "India",
  /** Courts with jurisdiction over disputes. */
  courts: "Mumbai, India",
  email: "salts-dev@proton.me",
  site: "salts.dev",
  updated: "26 November 2026",
  minimumAge: 18,
  /** One month, extendable by two. */
  responseDays: 30,
  /** California response window: 45 calendar days. */
  ccpaResponseDays: 45,
  /** Backup overwrite window quoted in the erasure clause. */
  backupDays: 30,
  /** Notice period for material changes. */
  noticeDays: 30,
} as const;

export type LegalTable = {
  caption: string;
  head: string[];
  rows: string[][];
};

export type LegalSection = {
  heading: string;
  /** Plain-English summary shown above the clause text. */
  summary: string;
  /** Clause text. Rendered as numbered sub-clauses: 4.1, 4.2, and so on. */
  clauses: string[];
  list?: string[];
  table?: LegalTable;
};

export type LegalDoc = {
  title: string;
  intro: string;
  sections: LegalSection[];
};

const O = LEGAL.operator;
const P = LEGAL.product;

/* ----------------------------------------------------------------- Terms -- */

export const TERMS: LegalDoc = {
  title: "Terms of Service",
  intro: `These Terms of Service (the "Terms") govern access to and use of ${P}, operated by ${O}, an individual based in ${LEGAL.country} ("${P}", "we", "us"). Each clause is preceded by a plain-English summary. The summary is provided for convenience; the clause governs.`,
  sections: [
    {
      heading: "1. Acceptance of the Terms",
      summary: `Using ${P} means you accept these Terms. If you do not accept them, do not use the Service.`,
      clauses: [
        `By creating an Account, configuring an Agent, or sending a message to an Agent through any interface we operate, you agree to be bound by these Terms and by the Privacy Policy, which is incorporated into these Terms by reference.`,
        `You represent that you are at least ${LEGAL.minimumAge} years of age. Where you accept these Terms on behalf of an entity, you represent that you have authority to bind that entity, and "you" refers to that entity and to you jointly.`,
        `The current version of the Terms is published at ${LEGAL.site}/terms and is identified by the "Last updated" date at the head of this page.`,
      ],
    },
    {
      heading: "2. Definitions",
      summary: "The capitalised words used throughout these Terms mean the following.",
      clauses: ["In these Terms, the following definitions apply:"],
      list: [
        `"Account" means the record identified by the email address with which you authenticate to the Service.`,
        `"Agent" means an instance of the assistant you create within the Service, together with its configuration, sessions and stored content.`,
        `"Administrator" means the Account designated as administrator of an Agent, and "Authorised User" means any Account listed on that Agent's access list.`,
        `"Fleet" means a group of Agents created and managed from one Account (the "Fleet Owner") for use by other people.`,
        `"Credentials" means an API key, bot token, access token, server URL, header or other secret you supply so that a Capability can operate, including OpenRouter API keys, a Telegram bot token and a WhatsApp access token.`,
        `"Wallet" means the part of the Service that holds your OpenRouter keys, and "Bought Key" means an OpenRouter key we create for you after you pay for it, by card, UPI or netbanking through Razorpay or with cryptocurrency.`,
        `"Input" means any message, instruction, file or other material submitted to an Agent, and "Output" means material an Agent generates in response.`,
        `"Model Provider" means the third party whose model generates an Output, reached on your behalf through OpenRouter.`,
        `"Connected Service" means any third-party service an Agent is configured to reach, including Telegram, WhatsApp, search providers and MCP servers.`,
        `"Service" means ${P}, comprising the hosted application, its interfaces and its integrations, but excluding any Connected Service.`,
      ],
    },
    {
      heading: "3. The Service",
      summary:
        "We host the Agent and the interface around it. The model that writes the replies is a third party's, reached with an OpenRouter key.",
      clauses: [
        `The Service enables you to create, configure and operate an Agent, and to converse with it through a browser and, where you connect them, through Telegram and WhatsApp.`,
        `We do not operate a language model. Each Output is generated by a Model Provider selected by your configuration and reached through OpenRouter using a key in your Wallet. The Model Provider's own terms and privacy policy govern its processing of the Input and its generation of the Output. We are not a party to that relationship and make no representation about any Model Provider.`,
        `The Service is provided on a best-efforts basis. We do not warrant continuous availability, and availability is in part determined by Connected Services outside our control.`,
        `Features designated as beta, preview or experimental may be changed or withdrawn at any time and are excluded from any commitment made elsewhere in these Terms.`,
      ],
    },
    {
      heading: "4. Accounts and access lists",
      summary:
        "You are responsible for your Account. Everyone on an Agent's access list can read its whole history and change its settings.",
      clauses: [
        `Accounts are created through our authentication provider and identified by an email address. You must provide accurate information and keep it current.`,
        `You are responsible for all activity conducted through your Account and for maintaining the confidentiality of your authentication credentials. You must notify us at ${LEGAL.email} promptly on becoming aware of unauthorised use.`,
        `Each Agent carries an access list. Every Authorised User on that list may read the Agent's entire message history, including Inputs submitted by other Authorised Users, may alter the Agent's configuration and may view its usage records. Adding an address to an access list constitutes your instruction to grant that access.`,
        `The Administrator may add or remove Authorised Users, including you, and may restrict which settings an Authorised User may change. Removal takes effect immediately and revokes further access to the Agent.`,
        `Accounts may not be shared. Each individual using the Service must hold an Account of their own.`,
      ],
    },
    {
      heading: "5. Fleets",
      summary:
        "A Fleet Owner gives Agents to other people. The owner sees what each Agent spends, not what its user says.",
      clauses: [
        `An Account may create a limited number of Agents. A higher limit, needed to create a Fleet, is available on request and is granted at our discretion. We may reduce a limit that is not being used.`,
        `A Fleet Owner may create Agents for other people, choose their settings and keys, and see the usage and spend of each Agent in the Fleet. A Fleet Owner cannot read the conversations of an Agent's user unless that user adds the Fleet Owner to the Agent's access list.`,
        `A Fleet Owner is responsible for the people to whom it gives Agents, including informing them how the Fleet operates and what the Fleet Owner can see, and for the charges incurred on the keys it supplies.`,
      ],
    },
    {
      heading: "6. Credentials and third-party accounts",
      summary:
        "You bring your own keys, bot and WhatsApp number, you pay their charges, and you must keep to their terms.",
      clauses: [
        `Operation of an Agent requires Credentials issued by third parties. You represent that you are entitled to use each Credential you supply and that doing so does not breach the terms of the issuer.`,
        `Model charges are paid from the credit on the OpenRouter key an Agent uses. We do not set or control those charges, and the credit on a key, or any limit set on it, is the only ceiling upon them. You are responsible for monitoring that spend.`,
        `A Telegram bot connected to an Agent remains subject to Telegram's terms of service. You are responsible for the conduct of that bot, including in any group or forum topic in which it is present, and for obtaining any consent required from the participants of that conversation.`,
        `A WhatsApp connection uses a phone number and access token from your own Meta developer account and remains subject to Meta's terms. An Agent connected to WhatsApp answers only the one WhatsApp number you set as your own. You must not use it to reach any other person or group, and doing so is a breach of these Terms that may lead to suspension.`,
        `You may remove any Credential from an Agent's settings at any time, which removes it from our storage. Removing a Credential does not revoke it at the issuer, and you remain responsible for revoking Credentials you no longer wish any party to hold.`,
      ],
    },
    {
      heading: "7. Fees and Bought Keys",
      summary:
        "Using Salts is free. If you buy a key, you pay its credit plus a service fee. Credits once issued cannot be transferred or refunded.",
      clauses: [
        `There is no charge for an Account or an Agent. We charge only when you buy a Bought Key, and we will give notice under clause 20 before introducing any other fee.`,
        `When you buy a Bought Key, you pay the credit you choose plus the service fee shown at checkout, either in Indian rupees by card, UPI or netbanking through Razorpay under clause 8, or in USDC or ETH under clause 9. The credit on a Bought Key is held in US dollars. Where you pay in rupees, the credit is the dollar equivalent of the rupee amount you chose, at the rate we apply at checkout, rounded down to the cent.`,
        `Every purchase is final. Credit on a Bought Key, and the service fee paid for it, cannot be refunded, transferred to another key or Account, or exchanged for cash, save where the law requires otherwise. A Bought Key cannot be topped up. Removing a Bought Key from your Wallet deletes it, and any credit remaining on it is lost.`,
        `We deliver a Bought Key once we have confirmed your payment. Where a payment was confirmed but no key was delivered, our sole obligation, and your sole remedy, is that we deliver the key, or a key holding the same credit, as described in the user guide.`,
        `A Bought Key is an OpenRouter key we create and hold for you, and it can be used only from your Wallet. Its credit is consumed under OpenRouter's terms at OpenRouter's prices, which we do not set or control.`,
        `Charges levied by OpenRouter, a Model Provider, a search provider or any other Connected Service under an account of your own are payable by you directly to that party. No refund is available from us in respect of those charges.`,
        `You are responsible for any tax that applies to your purchases.`,
      ],
    },
    {
      heading: "8. Card and UPI payments in India",
      summary:
        "Rupee payments go through Razorpay, a third party. We never see your card or UPI details, and we are not responsible when Razorpay, your bank or UPI fails.",
      clauses: [
        `Payments by card, UPI or netbanking are charged in Indian rupees and processed by Razorpay Software Private Limited ("Razorpay"), a third-party payment aggregator. Razorpay's terms and privacy policy govern the payment. We do not receive or store your card number, CVV, UPI PIN or bank credentials.`,
        `A payment counts only once Razorpay confirms to us that it was completed for the amount of your checkout. We are not responsible for a payment that is declined, delayed, interrupted or not confirmed, or for any amount that your bank debits without Razorpay confirming the payment to us. Such an amount is reversed, if at all, by Razorpay or your bank on their own timelines, and any claim for it lies against them. We will give you the payment reference we hold, on request.`,
        `We are not liable for any failure, outage, delay, error or security incident of Razorpay, your bank, a card network, the Unified Payments Interface, the National Payments Corporation of India or any other party in the payment chain, nor for any fee, currency conversion charge or limit that your bank or card issuer applies.`,
        `Where Razorpay confirmed your payment but no Bought Key was delivered, there is no self-service recovery for card or UPI payments. You must contact us at ${LEGAL.email} with the Razorpay payment reference, and we will deliver the key under clause 7.`,
        `If you raise a chargeback or payment dispute for a purchase whose Bought Key was delivered, we may disable that Bought Key and suspend your Account until the dispute is resolved.`,
      ],
    },
    {
      heading: "9. Crypto payments",
      summary:
        "Crypto payments are at your own risk. Networks can be congested, down or drop transactions, and payments cannot be reversed. If a payment does not reach us as quoted, we owe you nothing for it.",
      clauses: [
        `A crypto payment counts only if the exact amount quoted at checkout, in the asset and on the network quoted, from the wallet you connected, arrives at our address within the period shown at checkout and is confirmed on that network to the depth our systems require. A payment that does not meet every one of these conditions does not count as payment for that checkout, and we have no obligation to return, refund or credit it.`,
        `Cryptocurrency payments are irreversible. We do not hold or control your crypto wallet and cannot cancel, reverse or recover a transaction.`,
        `Where a payment that counts under this clause reached us but no Bought Key was delivered, you can recover the key yourself from your Wallet with the transaction id, as described in the user guide. If that recovery fails, you must contact us at ${LEGAL.email} with the transaction id, and we will deliver the key under clause 7.`,
        `YOU BEAR ALL RISK OF USING A BLOCKCHAIN NETWORK. WE ARE NOT RESPONSIBLE FOR, AND HAVE NO LIABILITY FOR ANY LOSS ARISING FROM: NETWORK CONGESTION, OUTAGES OR HALTS; DROPPED, STUCK, FAILED OR REPLACED TRANSACTIONS; DELAYS IN CONFIRMATION OR FINALITY; CHAIN REORGANISATIONS OR FORKS; THE FAILURE OF A BRIDGE, NODE OR RPC PROVIDER; A TOKEN ISSUER FREEZING, BLOCKING OR REVERSING A TOKEN; NETWORK OR GAS FEES; PRICE MOVEMENTS OF ANY ASSET; ERRORS, BUGS OR COMPROMISE OF YOUR WALLET SOFTWARE OR DEVICE; OR A PAYMENT SENT TO THE WRONG ADDRESS, ON THE WRONG NETWORK, IN THE WRONG ASSET OR IN THE WRONG AMOUNT.`,
        `Where a network is congested or unavailable, we may delay counting a payment or close crypto checkout without notice. A payment that is confirmed only after its checkout period has ended does not count, whatever the cause of the delay.`,
        `We do not provide any financial, investment, custody, exchange or money transmission service. A Bought Key is a prepaid credit for the Service, not a digital asset, and we make no representation as to the value of any cryptocurrency.`,
        `You are solely responsible for ensuring that holding and paying with cryptocurrency is lawful where you live, and for any tax, reporting or withholding obligation that arises from your payment.`,
      ],
    },
    {
      heading: "10. Acceptable use",
      summary: "Do not use an Agent to break the law, harm anyone, or abuse the infrastructure.",
      clauses: [
        `You shall not, and shall not permit any Authorised User or any person with access to a connected conversation to, use the Service to:`,
      ],
      list: [
        "violate any applicable law or regulation, or infringe the intellectual property, privacy, publicity or other rights of any person;",
        "generate, solicit or distribute material that sexually exploits or endangers minors, incites or threatens violence, or harasses, defames or discriminates against any person;",
        "impersonate any person or entity, or present an Output as having human authorship where that representation is deceptive;",
        "transmit unsolicited bulk communications, or operate an Agent in a Telegram group or channel without the consent of its administrator;",
        "connect an Agent on WhatsApp to any number other than your own, or to a WhatsApp group;",
        "upload or transmit malware, or material designed to interfere with the operation of any system;",
        "launder money, evade sanctions, or pay with funds you are not entitled to use;",
        "access, probe, scan or test the vulnerability of the Service, or circumvent any authentication, quota, rate limit or access control, whether of the Service or of a Connected Service, without our prior written consent;",
        "conduct prompt injection, jailbreaking or other adversarial testing against the Service without our prior written consent;",
        "scrape, crawl or extract data from the Service by automated means other than through an interface we provide for that purpose;",
        "resell, sublicense or provide the Service to a third party as a service of your own, other than by giving Agents to people through a Fleet.",
      ],
    },
    {
      heading: "11. Content, licence and Output",
      summary:
        "Your Inputs stay yours. Output is yours as between us. Output is machine-generated, so verify it.",
      clauses: [
        `As between you and us, you retain all right, title and interest in your Inputs. You grant us a worldwide, non-exclusive, royalty-free licence to host, store, reproduce, transmit and process your Inputs and Outputs solely to the extent necessary to operate the Service for you, including transmission to the Model Providers and Connected Services your configuration specifies. This licence terminates when you delete the material or the Agent that holds it.`,
        `You represent that you hold the rights necessary to submit each Input and that its submission and processing does not breach any obligation owed to a third party.`,
        `As between you and us, you own the Outputs generated for you, subject to the terms of the applicable Model Provider. Outputs are generated probabilistically, and identical or similar Outputs may be generated for other users. We make no claim to exclusivity in any Output.`,
        `We do not use your Inputs or Outputs to train models. Model Providers may do so under their own terms; where that matters to you, select a Model Provider whose terms prohibit it.`,
        `OUTPUTS MAY BE INACCURATE, INCOMPLETE OR FABRICATED, AND DO NOT CONSTITUTE LEGAL, MEDICAL, FINANCIAL OR OTHER PROFESSIONAL ADVICE. You are solely responsible for evaluating an Output before relying upon it and for any action an Agent takes on your instruction, including tool calls, scheduled tasks and messages it sends.`,
        `We may remove content that we reasonably believe breaches clause 10, and may use automated means to detect material we are legally obliged to act upon.`,
      ],
    },
    {
      heading: "12. Service limits and changes",
      summary: "There are usage limits, and features can change. Self-host if the limits do not suit you.",
      clauses: [
        `We may impose and vary usage limits, including limits on the number of Agents an Account may create, the number of chat sessions an Agent retains, file storage, the size of an upload, the number of keys in a Wallet, the amount of a single purchase and the rate of requests. Where an Agent exceeds a session limit, older sessions must be deleted before new ones are created.`,
        `We may add, modify, suspend or discontinue any feature. Where a change materially reduces the functionality of the Service, we will use reasonable efforts to give notice under clause 20.`,
        `The Service is open source and may be deployed by you on infrastructure you control. A deployment you operate is not the Service, is not covered by these Terms, and is your responsibility including as to security, availability and compliance.`,
      ],
    },
    {
      heading: "13. Suspension and termination",
      summary: "Leave whenever you like. We can suspend an Account that breaches these Terms.",
      clauses: [
        `You may terminate these Terms at any time by ceasing use of the Service, deleting your Agents and deactivating your Account. Deleting an Agent deletes its configuration, Credentials, sessions, messages, attachments and memories.`,
        `We may suspend or terminate access to the Service, in whole or in part, where we reasonably believe that you have breached these Terms, that continued access presents a risk to the Service or to another user, or that suspension is required by law. Where the breach is capable of remedy and suspension is not urgent, we will give notice and a reasonable opportunity to remedy it.`,
        `On termination, your right to use the Service ceases immediately. Content remaining in an Agent is deleted in accordance with the Privacy Policy. Credit remaining on a Bought Key is not refunded, except where we terminate without cause.`,
        `Clauses 2, 6.2, 7, 9, 12, 13, 14, 15, 16, 17 and 19 survive termination of these Terms.`,
      ],
    },
    {
      heading: "14. Intellectual property",
      summary: "Our name and marks remain ours. The code is open source under its own licence.",
      clauses: [
        `The source code of the Service is published under the open-source licence stated in its repository, and your use of that code is governed by that licence. Subject to these Terms, we grant you a limited, revocable, non-exclusive, non-transferable licence to access and use the hosted Service.`,
        `The name ${P}, its logos and its marks belong to ${O}. You shall not use them without prior written consent, other than to identify the Service factually.`,
        `You grant us a perpetual, irrevocable, royalty-free licence to use feedback and suggestions you provide, without obligation or attribution.`,
      ],
    },
    {
      heading: "15. Privacy and data protection",
      summary:
        "The Privacy Policy explains what we process. If other people message your Agent, you are responsible for what they send.",
      clauses: [
        `Our processing of personal data in operating the Service is described in the Privacy Policy, which forms part of these Terms.`,
        `Where you configure an Agent that receives Inputs from individuals other than yourself, including participants in a Telegram group or users of an Agent in your Fleet, you decide why and how that personal data is processed and we process it on your instructions. You are responsible for having a lawful basis for that processing and for telling those individuals how their data is used.`,
        `You authorise us to engage the service providers listed in the Privacy Policy, subject to the notification and objection procedure described there.`,
        `Where you require a data processing agreement, contact ${LEGAL.email}.`,
      ],
    },
    {
      heading: "16. Disclaimers",
      summary: "The Service is provided as it is, with no warranties.",
      clauses: [
        `THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTY OF ANY KIND. TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE DISCLAIM ALL WARRANTIES, EXPRESS, IMPLIED OR STATUTORY, INCLUDING THE IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, ACCURACY AND NON-INFRINGEMENT.`,
        `WE DO NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, TIMELY, SECURE OR ERROR-FREE, THAT ANY OUTPUT WILL BE ACCURATE OR SUITABLE FOR YOUR PURPOSE, OR THAT ANY CONNECTED SERVICE, MODEL PROVIDER, PAYMENT PROCESSOR, BANK OR BLOCKCHAIN NETWORK WILL CONTINUE TO BE AVAILABLE OR TO BEHAVE CONSISTENTLY.`,
        `Neither party is liable for any failure or delay in performance caused by an event beyond its reasonable control, including acts of God, natural disaster, epidemic, war, civil unrest, labour dispute, act of government, failure of a telecommunications, hosting, payment or blockchain network provider, and denial-of-service or other malicious attack.`,
        `Some jurisdictions do not allow the exclusion of implied warranties or of consumer rights. Nothing in this clause limits a right you hold that cannot lawfully be excluded.`,
      ],
    },
    {
      heading: "17. Limitation of liability",
      summary:
        "No liability for indirect loss, and our total liability is capped at what you paid us in the last year or USD 100, whichever is greater.",
      clauses: [
        `TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA, BUSINESS OR GOODWILL, WHETHER IN CONTRACT, TORT OR OTHERWISE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.`,
        `OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS SHALL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID US IN THE TWELVE MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM, AND (B) USD 100.`,
        `We are not liable for charges incurred on any OpenRouter key or with any other Connected Service, including charges resulting from configuration you chose or from use of your Credentials by a person you granted access.`,
        `We are not liable for any loss arising from a payment that is declined, delayed, dropped, not confirmed or not counted under clause 8 or clause 9. For a purchase, our liability shall in no event exceed the amount we actually received for it.`,
        `Nothing in these Terms excludes or limits liability for death or personal injury caused by negligence, for fraud or fraudulent misrepresentation, or for any other liability that cannot lawfully be excluded.`,
      ],
    },
    {
      heading: "18. Indemnification",
      summary: "If a third party sues us over your use of the Service, you cover the cost.",
      clauses: [
        `You shall indemnify and hold harmless ${O} against any third-party claim, and against damages, liabilities and reasonable legal costs finally awarded or agreed in settlement, arising out of or relating to your use of the Service, your Inputs, your Credentials, your operation of an Agent in a conversation involving other individuals or in a Fleet, or your breach of these Terms or of any applicable law.`,
        `We shall notify you promptly of any claim to which this clause applies, and may assume its defence with counsel of our choosing at your expense. You shall not settle any claim in a manner that imposes an obligation on us without our prior written consent.`,
      ],
    },
    {
      heading: "19. Governing law and disputes",
      summary: `Indian law governs. Write to us first; if that does not resolve it, the courts of ${LEGAL.courts} decide.`,
      clauses: [
        `These Terms and any dispute arising out of them are governed by the laws of ${LEGAL.jurisdiction}, without regard to conflict-of-laws principles, and subject to any mandatory law of your country of residence that cannot be excluded by agreement.`,
        `Before commencing proceedings, you shall send a written notice describing the dispute to ${LEGAL.email} and allow thirty (30) days from receipt for us to resolve it informally.`,
        `If the dispute is not resolved informally, the courts of ${LEGAL.courts} have exclusive jurisdiction, save that a consumer may bring proceedings in the courts of their place of residence where the law of that place gives them that right. Either party may seek urgent injunctive relief in any court of competent jurisdiction.`,
      ],
    },
    {
      heading: "20. Changes to the Terms",
      summary: `We may amend these Terms on ${LEGAL.noticeDays} days' notice for material changes.`,
      clauses: [
        `We may amend these Terms. A material amendment takes effect no earlier than ${LEGAL.noticeDays} days after we publish the amended Terms and notify you within the Service or by email to the address on your Account. A non-material amendment takes effect on publication.`,
        `Continued use of the Service after an amendment takes effect constitutes acceptance of it. If you do not accept an amendment, you must stop using the Service and may delete your Account before it takes effect.`,
      ],
    },
    {
      heading: "21. General provisions",
      summary: "The usual boilerplate: notices, assignment, severability, and the whole agreement.",
      clauses: [
        `These Terms and the Privacy Policy constitute the entire agreement between the parties in respect of the Service and supersede all prior understandings relating to it.`,
        `If any provision is held invalid or unenforceable, it shall be modified to the minimum extent necessary to make it enforceable, or severed, and the remaining provisions shall continue in full force.`,
        `No failure or delay in exercising a right constitutes a waiver of it, and no waiver is effective unless in writing.`,
        `You may not assign or transfer these Terms without our prior written consent. We may assign them to a company we form to operate the Service, or in connection with a merger, acquisition or sale of the Service, in which case we will notify you.`,
        `Nothing in these Terms creates a partnership, agency, joint venture or employment relationship between the parties.`,
        `Notices to you may be given by email to the address on your Account or by posting within the Service. Notices to us must be sent to ${LEGAL.email}. You consent to receive communications from us electronically.`,
        `Model Providers are intended third-party beneficiaries of clauses 6, 10 and 11 to the extent those clauses govern your use of their models. No other person has any right to enforce these Terms.`,
        `Headings are for convenience only and do not affect interpretation.`,
      ],
    },
    {
      heading: "22. Contact",
      summary: "Where to reach us.",
      clauses: [`${O}, ${LEGAL.country}. Email: ${LEGAL.email}.`],
    },
  ],
};

/* --------------------------------------------------------------- Privacy -- */

export const PRIVACY: LegalDoc = {
  title: "Privacy Policy",
  intro: `This Privacy Policy explains what personal data ${P} processes, why, who it is shared with, how long it is kept and what rights you have. ${P} is operated by ${O}, an individual based in ${LEGAL.country} ("${P}", "we", "us"). It is written to meet the Digital Personal Data Protection Act, 2023 of India, the EU and UK General Data Protection Regulation ("GDPR"), and, in section 14, the California Consumer Privacy Act.`,
  sections: [
    {
      heading: "1. Who we are and how to contact us",
      summary: "We are responsible for the data described here. This is the address to use.",
      clauses: [
        `The controller for the processing described in this Policy is ${O}, ${LEGAL.country}, operating ${P}.`,
        `Requests under this Policy, including requests to exercise your rights and complaints, should be sent to ${LEGAL.email}. ${O} handles them personally and acts as grievance officer for the purposes of Indian law.`,
      ],
    },
    {
      heading: "2. Scope and your own controllership",
      summary:
        "This Policy covers the service we run. Where other people message your Agent, you decide what happens to their data and we act for you.",
      clauses: [
        `This Policy applies to the hosted service we operate at ${LEGAL.site}. It does not apply to a deployment you host yourself, nor to any Connected Service, each of which publishes its own policy.`,
        `Where you create an Agent that receives messages from individuals other than yourself, including people in a Telegram group or people you give Agents to through a Fleet, you determine the purposes and means of that processing. You are the controller of that content and we process it only on your instructions. Telling those individuals how their data is used is your responsibility.`,
      ],
    },
    {
      heading: "3. Personal data we process",
      summary:
        "Your email, your Agent's settings and keys, everything sent to the Agent, what each reply cost, and how you paid for a key.",
      clauses: [
        `We process the categories of personal data set out below. Personal data is obtained directly from you, except where the source column states otherwise.`,
        `Account data and the Credentials an Agent needs are required to provide the Service: without them we cannot create an Account or operate an Agent.`,
      ],
      table: {
        caption: "Data categories, examples and source",
        head: ["Category", "Data", "Source"],
        rows: [
          [
            "Account data",
            "Email address, authentication identifiers and session metadata; the access list and administrator of each Agent; Fleet membership and agent limits",
            "You; our authentication provider",
          ],
          [
            "Agent configuration",
            "Agent name, selected model, system prompt, tuning parameters, enabled capabilities",
            "You, or the Fleet Owner who created the Agent",
          ],
          [
            "Credentials",
            "OpenRouter keys in your Wallet, Telegram bot token and username, WhatsApp access token and phone number ID, search API key, MCP server URLs and headers",
            "You; OpenRouter, for a key created by connecting your OpenRouter account or by a purchase",
          ],
          [
            "Conversation content",
            "Messages, attachments (documents, images, voice notes), text extracted from attachments, scheduled tasks, and facts saved to memory where that capability is enabled",
            "You and anyone you permit to message the Agent",
          ],
          [
            "Google Calendar data",
            "Where you connect Google Calendar: the connected Google account's email address, OAuth access and refresh tokens, and the calendars and events the Agent reads or changes at your request (titles, times, locations, guests and notes)",
            "Google, on your authorisation",
          ],
          [
            "Telegram data",
            "Chat, user and forum-topic identifiers, usernames, and the whitelists you configure",
            "Telegram, on receipt of a message",
          ],
          [
            "WhatsApp data",
            "Your WhatsApp phone number, message identifiers and delivery status",
            "You; Meta, on receipt of a message",
          ],
          [
            "Usage records",
            "Tokens consumed, cost in USD, latency and timestamp per reply; credit remaining on each key",
            "Generated by the Service; OpenRouter",
          ],
          [
            "Payment data",
            "For each card or UPI purchase: the amount in rupees, the Razorpay order and payment references and the key it bought. For each crypto purchase: the amount, network and coin, the wallet address you paid from, the transaction hash and the key it bought",
            "You; Razorpay; the public blockchain",
          ],
          [
            "Technical data",
            "IP address, request metadata, error diagnostics and security logs",
            "Generated automatically on each request",
          ],
        ],
      },
    },
    {
      heading: "4. Purposes and legal bases",
      summary: "Why we use each kind of data, and the legal ground for it.",
      clauses: [
        `We process personal data for the purposes and on the legal bases set out below. Where we rely on legitimate interests, the interest is stated.`,
        `We do not sell personal data, do not use conversation content for advertising or profiling, and do not use it to train models of our own.`,
      ],
      table: {
        caption: "Processing purposes and legal bases",
        head: ["Purpose", "Data", "Legal basis"],
        rows: [
          ["Creating and authenticating an Account", "Account data", "Performance of a contract with you"],
          [
            "Operating an Agent: storing conversations, routing model calls, delivering Telegram and WhatsApp messages, running scheduled tasks and enabled capabilities",
            "Agent configuration, Credentials, conversation content, Telegram and WhatsApp data",
            "Performance of a contract with you",
          ],
          [
            "Showing what each reply cost and how much credit each key has left, including to a Fleet Owner for the Agents in their Fleet",
            "Usage records",
            "Performance of a contract with you",
          ],
          [
            "Selling a Bought Key: quoting a price, confirming your payment with Razorpay or on the blockchain, and creating the key",
            "Account data, payment data",
            "Performance of a contract with you",
          ],
          [
            "Maintaining security and availability, preventing abuse and fraud, diagnosing faults",
            "Technical data, usage records, payment data",
            "Legitimate interest in operating a secure and functioning service",
          ],
          [
            "Responding to requests and enquiries",
            "Account data, correspondence",
            "Performance of a contract; legitimate interest in responding",
          ],
          [
            "Complying with legal obligations, including tax and accounting records, and responding to lawful requests",
            "Any of the above",
            "Legal obligation",
          ],
        ],
      },
    },
    {
      heading: "5. Who we share data with",
      summary:
        "Cloudflare hosts it, Clerk signs you in, OpenRouter routes the model call, Telegram and Meta carry the chat, Razorpay processes rupee payments.",
      clauses: [
        `We share personal data with the service providers listed below, each under a contract that limits its use of the data to providing its service to us.`,
        `We will give notice within the Service or by email before adding or replacing a service provider that processes your conversation content, and you may object by writing to ${LEGAL.email} within ${LEGAL.noticeDays} days. Where an objection cannot be accommodated, you may delete the affected Agent.`,
        `Content sent to a Model Provider or a Connected Service is processed by that party under its own terms. Some Model Providers use inputs and outputs to improve their models; where that matters to you, select a provider whose terms exclude it. An MCP server you connect is a third party of your choosing, which we do not vet.`,
        `We may also disclose personal data where required by law, court order or a binding request from a competent authority, and to a successor in connection with the transfer of the Service to a company or a buyer, in which case we will notify you.`,
        `We disclose personal data to a public authority only where we are legally required to. For every such request we (a) review whether it is lawful and within the authority's powers; (b) challenge it, or ask for it to be narrowed, where we consider it unlawful, overbroad or unclear; (c) disclose only the minimum personal data needed to comply; and (d) keep a record of the request, our response, the legal basis we relied on and the people involved.`,
      ],
      table: {
        caption: "Service providers and other recipients",
        head: ["Recipient", "Purpose", "Location"],
        rows: [
          ["Cloudflare, Inc.", "Hosting, storage, network and edge compute", "United States; global edge"],
          ["Clerk, Inc.", "Authentication and session management", "United States"],
          [
            "OpenRouter, Inc.",
            "Routing each model call to the Model Provider you selected; creating and funding Bought Keys",
            "United States",
          ],
          [
            "Model Providers",
            "Generating the Output for a call routed by OpenRouter; identity depends on the model you select",
            "Varies by provider",
          ],
          ["Telegram Messenger Inc.", "Delivering messages to and from a bot you connect", "Varies; see Telegram's policy"],
          [
            "Meta Platforms, Inc.",
            "Delivering WhatsApp messages through the WhatsApp Cloud API account you connect",
            "United States and other countries",
          ],
          [
            "Razorpay Software Private Limited",
            "Processing card, UPI and netbanking payments in rupees, and confirming them to us",
            "India",
          ],
          [
            "Google LLC",
            "Reading and changing the Google Calendar you connect, at your request",
            "United States",
          ],
          [
            "Blockchain node providers",
            "Reading your payment transaction from the blockchain to confirm it",
            "Varies by provider",
          ],
          [
            "Brave Software, Inc., or a SearXNG instance you nominate",
            "Executing a web search where that capability is enabled",
            "United States; or as you configure",
          ],
          [
            "MCP servers you connect",
            "Executing tool calls you have configured; recipient and location determined by you",
            "As you configure",
          ],
        ],
      },
    },
    {
      heading: "6. Credentials",
      summary: "Keys are stored so the Agent can use them, never displayed back to you, and removable at any time.",
      clauses: [
        `Credentials must be usable at the time of a call and are therefore stored in recoverable form rather than as a one-way hash. They are never returned in full to a browser, where the settings interface displays a mask, and are removed from storage when the field is cleared, the key is removed from your Wallet, or the Agent is deleted.`,
        `A Bought Key is never shown to you; it is held only in your Wallet. Removal from our storage does not revoke a key you supplied at its issuer. We recommend setting a credit limit on each OpenRouter key and rotating any Credential you believe may be compromised.`,
      ],
    },
    {
      heading: "7. Google user data",
      summary:
        "If you connect Google Calendar, your Agent reads and changes your calendar only to do what you ask. We never sell it, use it for ads, or train AI models on it.",
      clauses: [
        `${P}'s use and transfer of information received from Google APIs to any other app will adhere to the Google API Services User Data Policy (https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.`,
        `Data accessed. When you connect Google Calendar to an Agent, you authorise ${P} to see the list of your Google calendars, and to view, create, change and delete events on them. We store the email address of the connected Google account and the OAuth access and refresh tokens Google issues. We do not request access to your Gmail, Google Drive, contacts or any other Google service.`,
        `Data use. Calendar data is used only to provide the Google Calendar capability to you: to answer your questions about your schedule and to create, change or delete events when you, or someone you allow to message your Agent, asks for it. Event details the Agent reads are included in the conversation and sent to the Model Provider you selected, through OpenRouter, solely to generate the Agent's reply.`,
        `Data sharing. We do not sell Google user data, do not use or transfer it for advertising, retargeting or interest-based purposes, do not use it to determine creditworthiness or for lending, and do not use or transfer it to develop, improve or train generalised or non-personalised AI or machine-learning models. We transfer it only to the service providers in section 5 as needed to provide the capability, as necessary to comply with law, or as part of a merger, acquisition or sale of assets with notice to you. No person reads it unless you give us your explicit consent for specific data, it is needed for security purposes such as investigating abuse, or the law requires it.`,
        `Storage and protection. The tokens are stored in the Agent's isolated storage, encrypted at rest and in transit, are never returned to a browser, and are used only by the Service to call the Google Calendar API. Event details the Agent reads become part of the conversation and are kept with it, as section 10 describes.`,
        `Retention and deletion. Clicking Disconnect on the Agent's Capabilities page immediately deletes the stored tokens and asks Google to revoke them; deleting the Agent also deletes and revokes them, and an Account can only be deactivated once its Agents are deleted. You can also revoke ${P}'s access at any time from your Google Account's security settings (https://myaccount.google.com/permissions). To delete calendar details already in a conversation, delete that session; to have anything else deleted, write to ${LEGAL.email}.`,
      ],
    },
    {
      heading: "8. Payments",
      summary:
        "Razorpay handles rupee payments, so we never see your card or UPI details. A blockchain payment is public and permanent, and we never see your crypto wallet's keys.",
      clauses: [
        `When you pay in rupees by card, UPI or netbanking, the payment is processed by Razorpay, which collects the details needed to make it under its own privacy policy. We never receive or store your card number, CVV, UPI PIN or bank credentials. Razorpay tells us whether the payment was completed and its amount, and we keep the Razorpay order and payment references with the purchase.`,
        `When you pay with cryptocurrency, you pay from your own crypto wallet directly to our address, with no payment processor in between. We never receive or store your wallet's private keys or recovery phrase.`,
        `Transactions on a public blockchain, including the paying address, the amount and the time, are visible to anyone and cannot be altered or deleted, by us or anyone else. Linking that transaction to your Account happens only in our records.`,
      ],
    },
    {
      heading: "9. International transfers",
      summary: "Data leaves your country, because our providers and the model providers are global.",
      clauses: [
        `Personal data is transferred to, and processed in, countries other than your own, including India and the United States.`,
        `Where we transfer personal data from the European Economic Area or the United Kingdom to a country without an adequacy decision, we rely on the standard contractual clauses approved for that purpose, supplemented where necessary by additional safeguards. A copy of the safeguards applying to a given recipient is available on request to ${LEGAL.email}.`,
        `A transfer to a Connected Service you configure, including an MCP server, is made on your instruction and under the transfer mechanism, if any, of that provider.`,
      ],
    },
    {
      heading: "10. Retention",
      summary: "We keep things until you delete them; deleting an Agent deletes its contents.",
      clauses: [
        `Personal data is retained in accordance with the schedule below and then deleted or irreversibly anonymised.`,
        `Deleting a session deletes its messages, attachments and usage records. Deleting an Agent deletes its configuration, Credentials, sessions and memories, and revokes any Google Calendar access it held.`,
        `You can delete your Account yourself with Deactivate account in the account menu, once you administer no Agents and hold no keys in your Wallet and no business phone numbers, or by asking us at ${LEGAL.email}. Deactivating deletes your sign-in, your lists, your agent limit and limit requests, the computers you paired and any unused message balance. Because every Agent you administer is deleted first, no Google Calendar credentials remain. We keep payment records as the law requires and a record that a starter key was given to your address. Your place on the access list of an Agent administered by someone else belongs to that Administrator and is not removed.`,
        `Following deletion, residual copies may persist in backups and in provider logs until overwritten in the ordinary cycle, which is up to ${LEGAL.backupDays} days. Data we are required to retain for a legal purpose is retained for the period of that requirement and processed for no other purpose.`,
      ],
      table: {
        caption: "Retention schedule",
        head: ["Category", "Retention period", "Trigger"],
        rows: [
          ["Account data", "Life of the Account", "Account deletion"],
          ["Agent configuration and Credentials", "Life of the Agent, or until the field is cleared", "Agent deletion"],
          ["Wallet keys", "Until removed from your Wallet", "Removal or Account deletion"],
          ["Google Calendar tokens and account email", "Until you disconnect Google Calendar or delete the Agent", "Disconnect or Agent deletion"],
          ["Conversation content and attachments", "Until the session or Agent is deleted; no automatic expiry", "Session or Agent deletion"],
          ["Memories", "Until deleted by you or the Agent is deleted", "Agent deletion"],
          ["Usage records", "Life of the session", "Session deletion"],
          ["Payment records", "Life of the Account, and longer where tax or accounting law requires", "Account deletion and the end of any legal requirement"],
          ["Technical and security logs", "Up to 30 days", "Elapse of the retention window"],
          ["Backups", `Up to ${LEGAL.backupDays} days after deletion`, "Backup rotation"],
        ],
      },
    },
    {
      heading: "11. Security",
      summary: "Encryption in transit, per-Agent isolation, and access checked on every request.",
      clauses: [
        `We implement technical and organisational measures appropriate to the risk, including encryption of personal data in transit, isolation of each Agent's storage, authentication of every request against a cryptographically signed session token, and authorisation against the Agent's access list, which is held separately from the configuration it governs.`,
        `No system is perfectly secure. Where a personal data breach occurs, we will notify the competent authority and affected individuals as the law requires.`,
      ],
    },
    {
      heading: "12. Your rights",
      summary: `Access, correction, deletion, restriction, portability, objection. Email us; we answer within ${LEGAL.responseDays} days.`,
      clauses: [
        `You have the right to ask for access to your personal data, its correction or completion, its deletion, restriction of its processing and a portable copy of data you provided to us, and to object to processing based on legitimate interests. You may also nominate another person to exercise these rights on your behalf in the event of your death or incapacity. We extend these rights to all users, wherever they reside.`,
        `Where processing is based on consent, you may withdraw it at any time without affecting the lawfulness of processing carried out before withdrawal.`,
        `Many of these rights are exercisable directly: settings display and amend your configuration, sessions may be exported and deleted, and deleting an Agent erases its contents. For anything else, write to ${LEGAL.email}. We respond within one month of receipt and may extend that period by two further months where the request is complex, telling you why.`,
        `If you are not satisfied with our response, you may complain to the data protection authority where you live, work or where the issue arose. In India, that is the Data Protection Board of India; we ask that you write to us first, as Indian law requires.`,
        `We do not make automated decisions that have legal or similarly significant effects on you, and we do not profile you. An Output is generated automatically but makes no decision about you; what you do with it is your own decision.`,
        `We do not process personal data for any purpose other than those stated in section 4. Should we intend to do so, we will tell you beforehand.`,
      ],
    },
    {
      heading: "13. Cookies and local storage",
      summary: "Only what is needed to sign you in and remember your interface settings.",
      clauses: [
        `We use strictly necessary cookies and equivalent browser storage. We do not set advertising cookies, do not operate cross-site tracking, and do not run third-party analytics that profile you. Because this storage is strictly necessary, no consent banner is shown.`,
      ],
      table: {
        caption: "Cookies and equivalent storage",
        head: ["Type", "Purpose", "Duration"],
        rows: [
          ["Authentication", "Maintains your signed-in session", "Session, and as set by our authentication provider"],
          ["Security", "CSRF protection and abuse prevention", "Session"],
          ["Preferences", "Remembers interface settings such as the last Agent opened", "Local storage, until cleared"],
        ],
      },
    },
    {
      heading: "14. California residents",
      summary: "We collect the categories below, sell nothing, share nothing for advertising, and will not penalise you for asking.",
      clauses: [
        `This section applies to California residents and supplements the rest of this Policy.`,
        `In the twelve months preceding the date of this Policy we collected the categories of personal information set out below, for the purposes described in section 4, from the sources described in section 3, and disclosed them for a business purpose to the recipients listed in section 5.`,
        `We do not sell personal information and do not share it for cross-context behavioural advertising, and have not done so in the preceding twelve months, including in respect of consumers under 16 years of age.`,
        `The contents of your communications with an Agent are sensitive personal information under California law. We use them solely to provide the Service you requested, and we do not use or disclose them to infer characteristics about you.`,
        `You have the right to know what we collect, to delete it, to correct it, to limit the use of sensitive personal information, to opt out of sale or sharing, and not to be discriminated against for exercising any of these rights. Submit a request to ${LEGAL.email}; we confirm receipt within 10 business days and respond within ${LEGAL.ccpaResponseDays} calendar days, extendable once by a further 45 days where reasonably necessary.`,
        `An authorised agent may submit a request on your behalf with written permission signed by you, and we may require you to verify your identity directly. We verify requests by reference to control of the email address on the Account.`,
      ],
      table: {
        caption: "Categories collected in the preceding 12 months",
        head: ["Category", "Collected", "Examples"],
        rows: [
          ["Identifiers", "Yes", "Email address, account identifier, IP address, phone number, crypto wallet address"],
          ["Commercial information", "Yes", "Bought Keys purchased and their amounts"],
          ["Biometric information", "No", "—"],
          ["Internet or other electronic network activity", "Yes", "Request metadata, feature usage, error logs"],
          ["Geolocation data", "No", "Precise geolocation is not collected; IP address may imply coarse region"],
          ["Audio, electronic, visual or similar information", "Yes", "Voice notes and images you attach to a message"],
          ["Professional or employment information", "No", "Only where you choose to put it in a message"],
          ["Education information", "No", "—"],
          ["Inferences", "No", "We draw no profile from your data"],
          [
            "Sensitive personal information",
            "Yes",
            "Contents of your communications with an Agent; account credentials held by our authentication provider",
          ],
        ],
      },
    },
    {
      heading: "15. Children",
      summary: `The Service is not for anyone under ${LEGAL.minimumAge}.`,
      clauses: [
        `The Service is not directed at children and may not be used by anyone under ${LEGAL.minimumAge} years of age. We do not knowingly collect personal data from anyone under that age.`,
        `Where you operate an Agent in a conversation that may include children, you are responsible for any consent required. If you believe a child's personal data has reached us, write to ${LEGAL.email} and we will delete it without undue delay.`,
      ],
    },
    {
      heading: "16. Self-hosted deployments",
      summary: "Host it yourself and this Policy does not apply. You become responsible for the data.",
      clauses: [
        `${P} is open source and may be deployed on infrastructure you control. In that case personal data does not reach our systems, we have no role in processing it, and this Policy does not apply. The providers listed in section 5 continue to process data under the accounts you configure, and you are the controller in respect of that processing.`,
      ],
    },
    {
      heading: "17. Changes to this Policy",
      summary: "We date each version and tell you when a change is material.",
      clauses: [
        `We may amend this Policy. The "Last updated" date identifies the current version. Where an amendment materially affects the processing of your personal data, we will notify you within the Service or by email before it takes effect.`,
      ],
    },
    {
      heading: "18. Contact and complaints",
      summary: "Where to write, and who to complain to if we get it wrong.",
      clauses: [
        `${O}, ${LEGAL.country}. Email: ${LEGAL.email}.`,
        `You may complain to the data protection authority where you live, and in India to the Data Protection Board of India. We would ask that you raise the matter with us first.`,
      ],
    },
  ],
};
