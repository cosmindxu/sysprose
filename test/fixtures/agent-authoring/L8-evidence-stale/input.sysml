package EvidenceStale {
    part def Airframe {
        attribute mass : ISQ::MassValue = 19.5 [kg];
    }
    part airframe : Airframe;
    requirement def MassLimit {
        doc /* The airframe shall stay within the 25 kg limit. */
        subject airframe : Airframe;
        require constraint {
            airframe.mass <= 25.0 [kg]
        }
        @SysproseVerification::Evidence {
            attribute claim = "holds-at-values";
            attribute verdict = "inconclusive";
            attribute engine = "literal";
            attribute tool = "sysprose 0.1.0 (c560815202e7f7fbd5bbcbaa7a39e35ee5b773e5)";
            attribute modelGraph = "sha256:e82290e6915eac54114be403169fe66011dde430cba8f7ce445280ba5a6b32fb";
            attribute record = "{\"bound\":{\"detail\":\"the model’s own feature values, 1 of them; 0 free variables; compared as 18.5 vs 25 in M, coherent SI\",\"kind\":\"model-values\",\"si\":{\"dimension\":\"M\",\"lhs\":18.5,\"rhs\":25}},\"claim\":\"holds-at-values\",\"detail\":\"holds at the model's values (no assumptions — the pass is unconditional at these values)\",\"engine\":\"literal\",\"flags\":{\"allowInconclusive\":false,\"engine\":\"literal\",\"free\":[]},\"modelVersion\":{\"graph\":\"sha256:e82290e6915eac54114be403169fe66011dde430cba8f7ce445280ba5a6b32fb\",\"library\":38761,\"source\":\"sha256:f1e1b85f045db5ccb6b12572d74f273ca040ed0ab33517d8b9be18c2fa811f9f\",\"sysprose\":{\"git\":\"c560815202e7f7fbd5bbcbaa7a39e35ee5b773e5\",\"name\":\"sysprose\",\"version\":\"0.1.0\"}},\"obligation\":{\"clause\":\"EvidenceStale::MassLimit::«ConstraintUsage»\",\"expression\":\"airframe.mass <= 25.0 [kg]\",\"obligationDigest\":\"sha256:45c2b1e03c8d6d461724fd8ff5a392279b487adf16e83a1739c670ca4680267e\",\"requirement\":\"EvidenceStale::MassLimit\",\"shortId\":\"\"},\"producedBy\":\"sysprose verify --engine literal\",\"schema\":\"sysprose-evidence/1\",\"tool\":{\"git\":\"c560815202e7f7fbd5bbcbaa7a39e35ee5b773e5\",\"name\":\"sysprose\",\"version\":\"0.1.0\"},\"verdict\":\"inconclusive\",\"witness\":{\"kind\":\"model-values\",\"values\":[{\"path\":\"airframe.mass\",\"qualifiedName\":\"EvidenceStale::Airframe::mass\",\"role\":\"parameter\",\"unit\":\"kg\",\"value\":18.5}]}}";
        }
        metadata RequirementMetadata {
            attribute verdict = "inconclusive";
        }
    }
    satisfy MassLimit by airframe;
}
