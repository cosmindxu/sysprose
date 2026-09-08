package ContractAuthoringPrompts {

    doc /* The authoring rules a formal clause has to obey, written once, in the model, where an agent working on any requirement in this package is handed them. `#prompt` is guidance addressed to a machine reader: it binds nothing and constrains nothing. `npm run sysprose -- prompts <file> --element R` collects what applies to an element, and `property-draft` hands the same statements back verbatim beside the data dictionary, before a clause is written. They are written at PACKAGE level on purpose — guidance repeated onto every requirement that needs it is guidance that rots, and the walk that answers "what applies here" already reaches an element's owners. */

    #prompt part assumeOnlyOnInputs {
        doc /* Write an `assume` clause only over an input or a parameter — a value that reaches the subject from outside it. An assumption over something the subject computes is a guarantee wearing the wrong word: it lets the requirement discharge itself, and the run reports the result as vacuous rather than as a proof. */
    }

    #prompt part oneGuaranteePerRequire {
        doc /* State one guarantee per `require` clause. A body joining two promises with `and` is refuted as a whole, so the report cannot say which half failed and neither can the person reading it. Two clauses cost nothing and each gets its own verdict. */
    }

    #prompt part nameTheSubject {
        doc /* Name the subject in every path a clause reads: `payload.mass`, not `mass`. A bare feature name resolves to whichever match the scope walk reached first, and a model with two features of one name gives no way to see which was taken. `property-check` refuses a bare name for exactly that reason and suggests the qualified one. */
    }

    #prompt part neverHandWriteAVerdict {
        doc /* Never hand-write a `verdict` facet. A verdict is written by `evidence-attach` from a record a run produced, and a facet with nothing behind it is reported as claimed-without-evidence. If a verdict was reached by inspection rather than by this tool, say so in the requirement's prose. */
    }

    part def PayloadModule {
        attribute mass : ISQ::MassValue = 2.4 [kg];
        attribute mountingLoad : ISQ::ForceValue = 31.0 [N];
    }

    part payload : PayloadModule;

    requirement def PayloadMassRequirement {
        attribute id = "R-PAY-001";
        doc /* The payload module shall not exceed 3 kg, which is the mass the gimbal mount is qualified for. */
        subject payload : PayloadModule;
        require constraint { payload.mass <= 3.0 [kg] }
    }

    satisfy PayloadMassRequirement by payload;
}
