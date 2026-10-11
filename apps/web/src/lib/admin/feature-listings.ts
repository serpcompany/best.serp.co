/**
 * Listings that name one feature, add-on, model, or sub-tool of a larger site (Einstein GPT on
 * salesforce.com, Slack GPT), which a best page never pins (#405): its host's traffic measures
 * the parent product, so nothing ranks it (#349's rule). D1 has no column for this; the list is
 * `featureListings` in the reviewed mapping `d1/hygiene/2026-10-10-taxonomy.yaml`, by listing id
 * (stable across slug changes), and `feature-listings.test.ts` keeps the two equal. A listing that
 * isn't in the catalog (local fixtures, a later removal) is simply never matched.
 */
export const FEATURE_LISTING_IDS: ReadonlySet<string> = new Set([
  'lst_31a93dfdd1a9daea71399d95', // aws.amazon.com
  'lst_8a4ac7eb74fdcf1aebcfa16e', // ayoa.com
  'lst_cd4f6534709518e512eb802d', // bazaarvoice.com
  'lst_c6806b4adbbb65a7c7397030', // boloforms.com
  'lst_43ae562ab2420b083b4a2cd1', // buffer.com
  'lst_b669de52d4736f4e045e8284', // chai-research.com
  'lst_60654b29810d314ac4071b57', // coda.io
  'lst_9c7bf8d0e68785c74cd2448d', // codesandbox.io
  'lst_3fd4a20e001a5d82ecc1ddbf', // cohere.com
  'lst_13d6c48086b6ffd68daf23ff', // creativefabrica.com
  'lst_d0eb1d21af57e95091b2537a', // crisp.chat
  'lst_188cc4011a132f3258176d15', // dashword.com
  'lst_61ec380de1e7194c1d8634ca', // datasette.io
  'lst_bb6446d5879a2e746b224b6c', // deepnote.com
  'lst_76f39960871cc00bae41cd44', // deviantart.com
  'lst_78aaa7d453b9b40478966c25', // emojipedia.org
  'lst_23f0d92a5076fa3114048fa0', // eraser.io
  'lst_9f580d9e6266993556e3e887', // flick.social
  'lst_c988a50a050772d6cd3fbc40', // frontitude.com
  'lst_864992608e4295e26ac005b5', // futurimedia.com
  'lst_3904dbeab135f07dadba9af6', // goblin.tools
  'lst_7e4dfc81c43d49a2e9d17db1', // gong.io
  'lst_f8a67f719df72da7c82d419d', // goteleport.com
  'lst_672960460d8d1f47f7b025f0', // grain.com
  'lst_501525d47f04c10d5f177c06', // grammarly.com
  'lst_d55d77bf47740c0eaddc4682', // hiverhq.com
  'lst_bf0377170725d01de90ffb62', // httpie.io
  'lst_1f31337a943b53a5948269d1', // hubspot.com
  'lst_a1059399afb4c39fab03d6f6', // ibm.com
  'lst_9e37bca8f83e2858a5c06130', // icons8.com
  'lst_ecaf56ae30e976ce6ccba9c1', // intercom.com
  'lst_5b7ca8764bc5bee99f8d1408', // kive.ai
  'lst_daed633e32b6d282769ec311', // koala.sh
  'lst_785e5b5ec11c13a7dab59a28', // landbot.io
  'lst_9fe076b643406379c89a583d', // letsview.com
  'lst_651ae748fecf113a02cfd03b', // livechat.com
  'lst_8db60e406a07b3714b93d147', // livereacting.com
  'lst_b353697b1fc37fb8c828a699', // magictool.ai
  'lst_dda79bd41d7b4b2159a1c38b', // markcopy.ai
  'lst_07ba1fe335c6b87a4bd58b33', // medallia.com
  'lst_9d2be43809280c184c3b90e3', // merge.dev
  'lst_59cb69478cf7d3e7f2809de6', // microsoft.com
  'lst_5d0da7f081adae9c235ce80d', // miro.com
  'lst_f6073bce20eea78a33796081', // mixpanel.com
  'lst_d3d8797ed03a6ed8d7a24b34', // myheritage.com
  'lst_ecae1f2e223637cd3f1721d3', // myheritage.fr
  'lst_5a37a14cd7d2f2cbba8d0ae2', // navercorp.com
  'lst_d03084545300d5e43da9b589', // nvidia.com
  'lst_8dc866963dc832267ccfdcc9', // openai.com
  'lst_be6104e442383d421efbd4bb', // opera.com
  'lst_b480a68344b9a8eece879f3f', // photoleapapp.com
  'lst_1829fbded2edde3caa341313', // radaar.io
  'lst_fa4837d350588954da806d7c', // raycast.com
  'lst_480c5ac86878eb6958f475bd', // read.ai
  'lst_59b5574ffe924a3f7604daa2', // reflect.app
  'lst_7f018cc179b1ab753ba19042', // replit.com
  'lst_00700d96f8d85e30213dc9ef', // riverside.fm
  'lst_10ba1e2ad5fc4afb23b4520d', // rows.com
  'lst_b3c952a1fff0f768f119783d', // saga.so
  'lst_85e33fc0ffe8c02ec4145c19', // salesforce.com
  'lst_cfeb7d6810d707bd6b73fd9b', // sciencelogic.com
  'lst_6725c26ac9d0ac6e8446bad4', // sensible.so
  'lst_55b8c4f872d0ea0f76a49590', // seovendor.co
  'lst_74b46fabf684074f077416e0', // shutterstock.com
  'lst_b7639eebb5f7f3034943381b', // slack.com
  'lst_34dedd0969aa621718eb138e', // snapchat.com
  'lst_b0479abd8b81aefc09017251', // socialbee.com
  'lst_02c69023341a0ca2066d76be', // softr.io
  'lst_24b14b3ca1bad4fce3b24cd0', // stork.ai
  'lst_6243c9097d51790fea6dd695', // streamlabs.com
  'lst_4a276dc60e50cd5c1cd37877', // tailwindapp.com
  'lst_ca7963fc93efad2fbff32225', // themesberg.com
  'lst_80af6eca8917719828a782bd', // together.ai
  'lst_b7471a9d94fe805c7b97db1c', // user.com
  'lst_e20a14748cea7b2247f1216b', // vtiger.com
  'lst_fef20e110470167e8b29b742', // warp.dev
  'lst_2a3253fb3d661d8914a2e770', // webflow.com
  'lst_d008ec887c8dda320c9cac44', // whimsical.com
  'lst_b4d2f9f4314f39472ad55f00', // wix.com
  'lst_4f3b344b4a0c351b774ffdc6', // yext.com
  'lst_0ecec553c1cf538fef957e71', // yodlee.com
  'lst_064348ab26a2cea64f43daa1', // zoho.com
  'lst_76d610bebe80b2ff8d9d2777' // zoom.com
])

/** True for a listing a best page may never pin. */
export function isFeatureListing(id: string): boolean {
  return FEATURE_LISTING_IDS.has(id)
}
